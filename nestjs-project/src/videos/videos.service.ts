import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageInvalidPartsError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CompletedPart } from '../storage/storage.types';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../video-processing/video-processing.constants';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { generatePublicId, PUBLIC_ID_PATTERN } from './public-id.util';
import {
  VIDEO_PLAYBACK_URL_EXPIRES_IN_SECONDS,
  VIDEO_UPLOAD,
  videoStorageKeys,
} from './videos.constants';
import type {
  CreateVideoInput,
  PartUploadUrl,
  VideoDetails,
  VideoSummary,
  VideoUploadSession,
  VideoUploadState,
} from './videos.types';

const PG_UNIQUE_VIOLATION = '23505';

function isPublicIdConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: string; detail?: string };
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    (driverError.detail ?? '').includes('public_id')
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Pre-registers the video as a draft and starts a multipart upload that the
   * client sends straight to the object storage (phase-03-videos/TD-02).
   */
  async createDraft(
    userId: string,
    input: CreateVideoInput,
  ): Promise<VideoUploadSession> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const storageKey = videoStorageKeys.original(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      input.contentType,
    );
    const video = await this.insertWithUniquePublicId({
      id,
      channel_id: channel.id,
      title: input.title,
      status: VideoStatus.DRAFT,
      original_file_name: input.fileName,
      content_type: input.contentType,
      file_size: input.fileSize,
      storage_key: storageKey,
      upload_id: uploadId,
    });

    const partCount = VideosService.partCount(input.fileSize);
    return {
      id: video.id,
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      upload: {
        partSize: VIDEO_UPLOAD.PART_SIZE_BYTES,
        partCount,
        expiresIn: VIDEO_UPLOAD.URL_EXPIRES_IN_SECONDS,
        parts: await this.presignParts(
          video,
          uploadId,
          VideosService.range(partCount),
        ),
      },
    };
  }

  /**
   * Resume support (phase-03-videos/TD-02 Revision 2026-11-04): lists the
   * parts already in storage and re-signs only the missing ones.
   */
  async getUploadState(
    userId: string,
    publicId: string,
  ): Promise<VideoUploadState> {
    const video = await this.findOwnedDraft(userId, publicId);
    const uploadId = video.upload_id as string;
    const uploadedParts = await this.storageService.listParts(
      video.storage_key,
      uploadId,
    );
    const uploaded = new Set(uploadedParts.map((part) => part.partNumber));
    const partCount = VideosService.partCount(video.file_size);
    const missing = VideosService.range(partCount).filter(
      (partNumber) => !uploaded.has(partNumber),
    );

    return {
      publicId: video.public_id,
      status: video.status,
      partSize: VIDEO_UPLOAD.PART_SIZE_BYTES,
      partCount,
      expiresIn: VIDEO_UPLOAD.URL_EXPIRES_IN_SECONDS,
      uploadedParts,
      parts: await this.presignParts(video, uploadId, missing),
    };
  }

  /**
   * Finishes the direct-to-storage upload, checks the assembled size, moves
   * the video to `processing` and publishes the `process-video` job
   * (phase-03-videos/TD-02, TD-07).
   */
  async completeUpload(
    userId: string,
    publicId: string,
    parts: CompletedPart[],
  ): Promise<VideoSummary> {
    const video = await this.findOwnedDraft(userId, publicId);
    const uploadId = video.upload_id as string;

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        uploadId,
        parts,
      );
    } catch (error) {
      if (error instanceof StorageInvalidPartsError) {
        throw new UploadIncompleteException();
      }
      throw error;
    }

    const storedSize = await this.storageService.headObjectSize(
      video.storage_key,
    );
    if (storedSize !== video.file_size) {
      throw new UploadSizeMismatchException();
    }

    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });
    try {
      await this.videoQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        VIDEO_PROCESSING_JOB_OPTIONS,
      );
    } catch (error) {
      // Keep the video completable: without a job it would stay `processing`
      // forever.
      await this.videoRepository.update(video.id, {
        status: VideoStatus.DRAFT,
        upload_id: uploadId,
      });
      throw error;
    }

    return {
      id: video.id,
      publicId: video.public_id,
      title: video.title,
      status: VideoStatus.PROCESSING,
    };
  }

  /** Public details resolved from the unique public id (TD-05, TD-06). */
  async getPublicDetails(publicId: string): Promise<VideoDetails> {
    const video = await this.findByPublicId(publicId);
    const thumbnailUrl =
      video.status === VideoStatus.READY && video.thumbnail_key
        ? await this.storageService.presignGet(video.thumbnail_key, {
            expiresIn: VIDEO_PLAYBACK_URL_EXPIRES_IN_SECONDS,
          })
        : null;

    return {
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl,
      createdAt: video.created_at,
    };
  }

  /**
   * Presigned URL for playback: the object storage serves Range requests
   * with 206 Partial Content (phase-03-videos/TD-06).
   */
  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findReady(publicId);
    return this.storageService.presignGet(video.storage_key, {
      expiresIn: VIDEO_PLAYBACK_URL_EXPIRES_IN_SECONDS,
    });
  }

  /** Presigned URL forcing a download with the original file name. */
  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findReady(publicId);
    return this.storageService.presignGet(video.storage_key, {
      expiresIn: VIDEO_PLAYBACK_URL_EXPIRES_IN_SECONDS,
      downloadFileName: video.original_file_name,
    });
  }

  private async findByPublicId(publicId: string): Promise<Video> {
    if (!PUBLIC_ID_PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOneBy({
      public_id: publicId,
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findReady(publicId: string): Promise<Video> {
    const video = await this.findByPublicId(publicId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  // Owner-only lookup: a video owned by someone else is reported as not found
  // so its existence is not leaked (### Authorization Matrix).
  private async findOwned(userId: string, publicId: string): Promise<Video> {
    if (!PUBLIC_ID_PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    if (!video || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findOwnedDraft(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findOwned(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotDraftException();
    }
    return video;
  }

  private async insertWithUniquePublicId(data: Partial<Video>): Promise<Video> {
    for (
      let attempt = 1;
      attempt <= VIDEO_UPLOAD.PUBLIC_ID_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...data,
            public_id: generatePublicId(),
          }),
        );
      } catch (error) {
        if (!isPublicIdConflict(error)) {
          throw error;
        }
      }
    }
    throw new Error(
      'Could not generate a unique video public id after max attempts',
    );
  }

  private async presignParts(
    video: Video,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PartUploadUrl[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
          VIDEO_UPLOAD.URL_EXPIRES_IN_SECONDS,
        ),
      })),
    );
  }

  private static partCount(fileSize: number): number {
    return Math.ceil(fileSize / VIDEO_UPLOAD.PART_SIZE_BYTES);
  }

  private static range(count: number): number[] {
    return Array.from({ length: count }, (_, index) => index + 1);
  }
}

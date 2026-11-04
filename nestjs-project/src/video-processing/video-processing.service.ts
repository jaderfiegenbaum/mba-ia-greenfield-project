import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { videoStorageKeys } from '../videos/videos.constants';
import { MediaProbeService } from './media-probe.service';

// Presigned URL lifetime for ffprobe/ffmpeg reads inside the worker.
const SOURCE_URL_EXPIRES_IN_SECONDS = 2 * 60 * 60;
const PROCESSING_ERROR_MAX_LENGTH = 500;

export interface ProcessVideoOptions {
  isFinalAttempt: boolean;
}

/**
 * Processing step of the video lifecycle (phase-03-videos/TD-04, TD-07):
 * probes duration/metadata, captures the thumbnail and marks the video
 * `ready`; on the final failed attempt marks it `failed`.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
  ) {}

  async processVideo(
    videoId: string,
    options: ProcessVideoOptions,
  ): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    // At-least-once delivery: a redelivered job for a video that is gone or
    // already finished is a no-op.
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping video ${videoId}: ${video ? `status ${video.status}` : 'not found'}`,
      );
      return;
    }

    try {
      const sourceUrl = await this.storageService.presignInternalGet(
        video.storage_key,
        SOURCE_URL_EXPIRES_IN_SECONDS,
      );
      const { durationSeconds, metadata } =
        await this.mediaProbeService.probe(sourceUrl);
      const thumbnail = await this.mediaProbeService.captureThumbnail(
        sourceUrl,
        durationSeconds,
      );
      const thumbnailKey = videoStorageKeys.thumbnail(video.id);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnail,
        'image/jpeg',
      );

      await this.videoRepository.update(video.id, {
        status: VideoStatus.READY,
        duration_seconds: durationSeconds,
        metadata,
        thumbnail_key: thumbnailKey,
        processing_error: null,
      });
    } catch (error) {
      if (options.isFinalAttempt) {
        const message = error instanceof Error ? error.message : String(error);
        await this.videoRepository.update(video.id, {
          status: VideoStatus.FAILED,
          processing_error: message.slice(0, PROCESSING_ERROR_MAX_LENGTH),
        });
      }
      throw error;
    }
  }
}

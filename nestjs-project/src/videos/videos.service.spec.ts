import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageInvalidPartsError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
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
import { VideosService } from './videos.service';

const OWNER_ID = 'owner-user-id';
const PART = 100 * 1024 * 1024;

function uniqueViolation(detail: string): QueryFailedError {
  return new QueryFailedError('INSERT', [], {
    code: '23505',
    detail,
  } as unknown as Error);
}

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    channel_id: 'channel-id',
    channel: { id: 'channel-id', user_id: OWNER_ID },
    public_id: 'AbCdEfGhIjK',
    title: 'Clip',
    status: VideoStatus.DRAFT,
    original_file_name: 'clip.mp4',
    content_type: 'video/mp4',
    file_size: 3 * PART,
    storage_key: 'videos/video-id/original',
    upload_id: 'upload-id',
    thumbnail_key: null,
    duration_seconds: null,
    metadata: null,
    processing_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((data: Partial<Video>) => data),
    save: jest.fn<Promise<Partial<Video>>, [Partial<Video>]>(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    update: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObjectSize: jest.fn(),
    presignGet: jest.fn(),
  };
  const videoQueue = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: videoQueue,
        },
      ],
    }).compile();
    service = module.get(VideosService);

    channelsService.findByUserId.mockResolvedValue({
      id: 'channel-id',
      user_id: OWNER_ID,
    });
    storageService.createMultipartUpload.mockResolvedValue('upload-id');
    storageService.presignUploadPart.mockImplementation(
      (_key: string, _uploadId: string, partNumber: number) =>
        Promise.resolve(`http://storage/part-${partNumber}`),
    );
    videoRepository.save.mockImplementation((data: Partial<Video>) =>
      Promise.resolve({ ...data, status: VideoStatus.DRAFT }),
    );
  });

  const input = {
    title: 'Clip',
    fileName: 'clip.mp4',
    fileSize: 250 * 1024 * 1024,
    contentType: 'video/mp4',
  };

  describe('createDraft', () => {
    it('should reject a user without channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.createDraft(OWNER_ID, input)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should return one presigned URL per 100 MiB part', async () => {
      const session = await service.createDraft(OWNER_ID, input);

      expect(session.status).toBe(VideoStatus.DRAFT);
      expect(session.upload.partSize).toBe(PART);
      expect(session.upload.partCount).toBe(3);
      expect(session.upload.parts).toEqual([
        { partNumber: 1, url: 'http://storage/part-1' },
        { partNumber: 2, url: 'http://storage/part-2' },
        { partNumber: 3, url: 'http://storage/part-3' },
      ]);
    });

    it('should store the multipart upload id and the per-video storage key', async () => {
      const session = await service.createDraft(OWNER_ID, input);

      const saved = videoRepository.save.mock.calls[0][0];
      expect(saved.upload_id).toBe('upload-id');
      expect(saved.storage_key).toBe(`videos/${session.id}/original`);
      expect(saved.channel_id).toBe('channel-id');
    });

    it('should retry with a new public id when the unique index conflicts', async () => {
      videoRepository.save
        .mockRejectedValueOnce(
          uniqueViolation('Key (public_id)=(x) already exists.'),
        )
        .mockImplementationOnce((data: Partial<Video>) =>
          Promise.resolve({ ...data, status: VideoStatus.DRAFT }),
        );

      const session = await service.createDraft(OWNER_ID, input);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const first = videoRepository.save.mock.calls[0][0];
      const second = videoRepository.save.mock.calls[1][0];
      expect(first.public_id).not.toBe(second.public_id);
      expect(session.publicId).toBe(second.public_id);
    });

    it('should propagate unique violations unrelated to public_id', async () => {
      const error = uniqueViolation('Key (id)=(x) already exists.');
      videoRepository.save.mockRejectedValueOnce(error);

      await expect(service.createDraft(OWNER_ID, input)).rejects.toBe(error);
    });
  });

  describe('getUploadState', () => {
    it('should hide videos owned by someone else', async () => {
      videoRepository.findOne.mockResolvedValue(buildVideo());

      await expect(
        service.getUploadState('another-user', 'AbCdEfGhIjK'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject a malformed public id without querying', async () => {
      await expect(
        service.getUploadState(OWNER_ID, 'not-valid'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it('should reject videos that left the draft status', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.getUploadState(OWNER_ID, 'AbCdEfGhIjK'),
      ).rejects.toBeInstanceOf(VideoNotDraftException);
    });

    it('should re-sign only the parts not uploaded yet', async () => {
      videoRepository.findOne.mockResolvedValue(buildVideo());
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"e1"', size: PART },
      ]);

      const state = await service.getUploadState(OWNER_ID, 'AbCdEfGhIjK');

      expect(state.partCount).toBe(3);
      expect(state.uploadedParts).toEqual([
        { partNumber: 1, etag: '"e1"', size: PART },
      ]);
      expect(state.parts.map((part) => part.partNumber)).toEqual([2, 3]);
    });
  });

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, etag: '"e1"' }];

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ file_size: 1024 }),
      );
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.headObjectSize.mockResolvedValue(1024);
      videoQueue.add.mockResolvedValue({ id: 'job-1' });
    });

    it('should move the video to processing and publish the job', async () => {
      const summary = await service.completeUpload(
        OWNER_ID,
        'AbCdEfGhIjK',
        parts,
      );

      expect(summary.status).toBe(VideoStatus.PROCESSING);
      expect(videoRepository.update).toHaveBeenCalledWith('video-id', {
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      expect(videoQueue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        { videoId: 'video-id' },
        VIDEO_PROCESSING_JOB_OPTIONS,
      );
      expect(VIDEO_PROCESSING_JOB_OPTIONS).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      });
    });

    it('should map rejected parts to UPLOAD_INCOMPLETE without publishing', async () => {
      storageService.completeMultipartUpload.mockRejectedValue(
        new StorageInvalidPartsError('InvalidPart'),
      );

      await expect(
        service.completeUpload(OWNER_ID, 'AbCdEfGhIjK', parts),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(videoQueue.add).not.toHaveBeenCalled();
    });

    it('should reject an assembled object whose size differs from the declared one', async () => {
      storageService.headObjectSize.mockResolvedValue(1000);

      await expect(
        service.completeUpload(OWNER_ID, 'AbCdEfGhIjK', parts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(videoQueue.add).not.toHaveBeenCalled();
    });

    it('should revert the video to draft when the job cannot be published', async () => {
      const error = new Error('redis down');
      videoQueue.add.mockRejectedValue(error);

      await expect(
        service.completeUpload(OWNER_ID, 'AbCdEfGhIjK', parts),
      ).rejects.toBe(error);
      expect(videoRepository.update).toHaveBeenLastCalledWith('video-id', {
        status: VideoStatus.DRAFT,
        upload_id: 'upload-id',
      });
    });

    it('should refuse to complete a video that is no longer a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.completeUpload(OWNER_ID, 'AbCdEfGhIjK', parts),
      ).rejects.toBeInstanceOf(VideoNotDraftException);
    });
  });

  describe('public playback', () => {
    beforeEach(() => {
      storageService.presignGet.mockResolvedValue('http://storage/signed');
    });

    it('should report unknown and malformed public ids as not found', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.getPublicDetails('AbCdEfGhIjK'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(service.getStreamUrl('bad')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('should expose a thumbnail URL only for ready videos', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );
      const processing = await service.getPublicDetails('AbCdEfGhIjK');
      expect(processing.thumbnailUrl).toBeNull();

      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-id/thumbnail.jpg',
          duration_seconds: 4,
        }),
      );
      const ready = await service.getPublicDetails('AbCdEfGhIjK');
      expect(ready.thumbnailUrl).toBe('http://storage/signed');
      expect(ready.durationSeconds).toBe(4);
      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/video-id/thumbnail.jpg',
        { expiresIn: 3600 },
      );
    });

    it('should refuse to stream or download a video that is not ready', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(service.getStreamUrl('AbCdEfGhIjK')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
      await expect(
        service.getDownloadUrl('AbCdEfGhIjK'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });

    it('should sign stream URLs inline and download URLs as attachments', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        buildVideo({ status: VideoStatus.READY }),
      );

      await service.getStreamUrl('AbCdEfGhIjK');
      await service.getDownloadUrl('AbCdEfGhIjK');

      expect(storageService.presignGet).toHaveBeenNthCalledWith(
        1,
        'videos/video-id/original',
        { expiresIn: 3600 },
      );
      expect(storageService.presignGet).toHaveBeenNthCalledWith(
        2,
        'videos/video-id/original',
        { expiresIn: 3600, downloadFileName: 'clip.mp4' },
      );
    });
  });
});

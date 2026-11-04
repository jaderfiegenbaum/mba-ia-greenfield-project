import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaProbeError } from './media-probe.errors';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const videoRepository = { findOneBy: jest.fn(), update: jest.fn() };
  const storageService = {
    presignInternalGet: jest.fn(),
    putObject: jest.fn(),
  };
  const mediaProbeService = { probe: jest.fn(), captureThumbnail: jest.fn() };
  const metadata = {
    formatName: 'mp4',
    bitRate: 1000,
    width: 640,
    height: 360,
    videoCodec: 'h264',
    audioCodec: 'aac',
    frameRate: 25,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: MediaProbeService, useValue: mediaProbeService },
      ],
    }).compile();
    service = module.get(VideoProcessingService);

    videoRepository.findOneBy.mockResolvedValue({
      id: 'video-id',
      status: VideoStatus.PROCESSING,
      storage_key: 'videos/video-id/original',
    });
    storageService.presignInternalGet.mockResolvedValue('http://minio/src');
    mediaProbeService.probe.mockResolvedValue({
      durationSeconds: 4,
      metadata,
    });
    mediaProbeService.captureThumbnail.mockResolvedValue(Buffer.from('jpg'));
  });

  it('should mark the video ready with duration, metadata and thumbnail', async () => {
    await service.processVideo('video-id', { isFinalAttempt: false });

    expect(storageService.putObject).toHaveBeenCalledWith(
      'videos/video-id/thumbnail.jpg',
      Buffer.from('jpg'),
      'image/jpeg',
    );
    expect(videoRepository.update).toHaveBeenCalledWith('video-id', {
      status: VideoStatus.READY,
      duration_seconds: 4,
      metadata,
      thumbnail_key: 'videos/video-id/thumbnail.jpg',
      processing_error: null,
    });
  });

  it.each([
    ['missing', null],
    ['already ready', { id: 'video-id', status: VideoStatus.READY }],
    ['still a draft', { id: 'video-id', status: VideoStatus.DRAFT }],
  ])('should ignore a video that is %s', async (_label, video) => {
    videoRepository.findOneBy.mockResolvedValue(video);

    await service.processVideo('video-id', { isFinalAttempt: true });

    expect(mediaProbeService.probe).not.toHaveBeenCalled();
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('should rethrow without changing the status on an intermediate failure', async () => {
    const error = new MediaProbeError('ffprobe exited with code 1');
    mediaProbeService.probe.mockRejectedValue(error);

    await expect(
      service.processVideo('video-id', { isFinalAttempt: false }),
    ).rejects.toBe(error);
    expect(videoRepository.update).not.toHaveBeenCalled();
  });

  it('should mark the video failed with a truncated error on the final attempt', async () => {
    mediaProbeService.probe.mockRejectedValue(new Error('x'.repeat(800)));

    await expect(
      service.processVideo('video-id', { isFinalAttempt: true }),
    ).rejects.toThrow();
    expect(videoRepository.update).toHaveBeenCalledWith('video-id', {
      status: VideoStatus.FAILED,
      processing_error: 'x'.repeat(500),
    });
  });
});

import { randomUUID } from 'node:crypto';
import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { createSyntheticVideo } from '../test/synthetic-video';
import { createVideosIntegrationModule } from '../test/videos-test-module';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let service: VideoProcessingService;
  let channelId: string;
  let syntheticVideo: Buffer;

  beforeAll(async () => {
    module = await createVideosIntegrationModule({
      providers: [MediaProbeService, VideoProcessingService],
    });
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    service = module.get(VideoProcessingService);
    syntheticVideo = await createSyntheticVideo();
  }, 60000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `processing_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    const nickname = `proc${randomUUID().slice(0, 8)}`;
    const channel = await dataSource.getRepository(Channel).save({
      name: nickname,
      nickname,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  async function seedProcessingVideo(content: Buffer): Promise<Video> {
    const id = randomUUID();
    const storageKey = `videos/${id}/original`;
    await storage.putObject(storageKey, content, 'video/mp4');
    return dataSource.getRepository(Video).save({
      id,
      channel_id: channelId,
      public_id: randomUUID().replace(/-/g, '').slice(0, 11),
      title: 'Processing test',
      status: VideoStatus.PROCESSING,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      file_size: content.length,
      storage_key: storageKey,
    });
  }

  it('should take a processing video to ready with metadata and a stored thumbnail', async () => {
    const video = await seedProcessingVideo(syntheticVideo);

    await service.processVideo(video.id, { isFinalAttempt: false });

    const stored = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.READY);
    expect(stored.duration_seconds).toBeGreaterThan(3.9);
    expect(stored.duration_seconds).toBeLessThan(4.1);
    expect(stored.metadata).toMatchObject({ width: 640, height: 360 });
    expect(stored.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    const thumbnail = await fetch(
      await storage.presignInternalGet(stored.thumbnail_key as string, 60),
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  }, 60000);

  it('should mark a non-video file as failed only on the final attempt', async () => {
    const video = await seedProcessingVideo(Buffer.from('not a video'));

    await expect(
      service.processVideo(video.id, { isFinalAttempt: false }),
    ).rejects.toThrow();
    const afterFirst = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(afterFirst.status).toBe(VideoStatus.PROCESSING);

    await expect(
      service.processVideo(video.id, { isFinalAttempt: true }),
    ).rejects.toThrow();
    const afterFinal = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(afterFinal.status).toBe(VideoStatus.FAILED);
    expect(afterFinal.processing_error).toBeTruthy();
  });

  it('should leave a ready video untouched when the job is redelivered', async () => {
    const video = await seedProcessingVideo(syntheticVideo);
    await service.processVideo(video.id, { isFinalAttempt: false });
    const first = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });

    await service.processVideo(video.id, { isFinalAttempt: false });

    const second = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(second.updated_at).toEqual(first.updated_at);
    expect(second.status).toBe(VideoStatus.READY);
  }, 60000);
});

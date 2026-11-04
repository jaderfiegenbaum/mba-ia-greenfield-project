import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { findVideoJobs } from '../test/find-video-jobs';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../video-processing/video-processing.constants';
import { cleanAllTables } from '../test/create-test-data-source';
import { createVideosIntegrationModule } from '../test/videos-test-module';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let queue: Queue;
  let userId: string;
  let counter = 0;

  beforeAll(async () => {
    module = await createVideosIntegrationModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
      providers: [VideosService],
    });
    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // The worker container may consume jobs concurrently; pause the queue
    // globally so jobs published here stay observable.
    await queue.pause();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.resume();
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    counter += 1;
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${counter}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: `vsvc${counter}`,
      nickname: `vsvc${counter}`,
      user_id: user.id,
    });
    userId = user.id;
  });

  const body = Buffer.from('fake video bytes for a single part upload');

  describe('createDraft', () => {
    it('should persist a draft video with the multipart upload id', async () => {
      const session = await service.createDraft(userId, {
        title: 'Integration clip',
        fileName: 'clip.mp4',
        fileSize: body.length,
        contentType: 'video/mp4',
      });

      const stored = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: session.publicId });
      expect(stored.status).toBe(VideoStatus.DRAFT);
      expect(stored.upload_id).toBeTruthy();
      expect(stored.storage_key).toBe(`videos/${stored.id}/original`);
      expect(stored.file_size).toBe(body.length);
      expect(session.upload.partCount).toBe(1);
      expect(session.upload.parts).toHaveLength(1);
    });
  });

  describe('getUploadState', () => {
    it('should report an uploaded part and stop offering its URL', async () => {
      const session = await service.createDraft(userId, {
        title: 'Resumable clip',
        fileName: 'clip.mp4',
        fileSize: body.length,
        contentType: 'video/mp4',
      });
      const before = await service.getUploadState(userId, session.publicId);
      expect(before.uploadedParts).toEqual([]);
      expect(before.parts.map((part) => part.partNumber)).toEqual([1]);

      const response = await fetch(session.upload.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(response.status).toBe(200);

      const after = await service.getUploadState(userId, session.publicId);
      expect(after.uploadedParts).toEqual([
        {
          partNumber: 1,
          etag: response.headers.get('etag'),
          size: body.length,
        },
      ]);
      expect(after.parts).toEqual([]);
    });
  });

  describe('completeUpload', () => {
    it('should persist processing and publish one process-video job', async () => {
      await queue.obliterate({ force: true });
      const session = await service.createDraft(userId, {
        title: 'Complete me',
        fileName: 'clip.mp4',
        fileSize: body.length,
        contentType: 'video/mp4',
      });
      const response = await fetch(session.upload.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });

      const summary = await service.completeUpload(userId, session.publicId, [
        { partNumber: 1, etag: response.headers.get('etag') as string },
      ]);

      expect(summary.status).toBe(VideoStatus.PROCESSING);
      const stored = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: session.id });
      expect(stored.status).toBe(VideoStatus.PROCESSING);
      expect(stored.upload_id).toBeNull();
      const jobs = await findVideoJobs(queue, session.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
      expect(jobs[0].data).toEqual({ videoId: session.id });
      expect(jobs[0].opts.attempts).toBe(3);
    });
  });
});

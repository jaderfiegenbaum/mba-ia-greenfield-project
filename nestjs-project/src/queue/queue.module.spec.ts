import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and expose the video-processing queue with its default job options', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    expect(queue.defaultJobOptions).toMatchObject({ attempts: 3 });
    await module.close();
  });
});

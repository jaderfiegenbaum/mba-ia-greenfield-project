import { Test } from '@nestjs/testing';
import { VideoProcessingProcessor } from './video-processing/video-processing.processor';
import { VideoProcessingService } from './video-processing/video-processing.service';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the queue consumer, storage and FFmpeg adapter', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    await module.close();
  }, 30000);
});

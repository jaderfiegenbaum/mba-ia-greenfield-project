import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingService } from './video-processing.service';

// Consumer of the video-processing queue; runs only in the video worker
// process (phase-03-videos/TD-03).
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    await this.videoProcessingService.processVideo(job.data.videoId, {
      isFinalAttempt: job.attemptsMade + 1 >= attempts,
    });
  }
}

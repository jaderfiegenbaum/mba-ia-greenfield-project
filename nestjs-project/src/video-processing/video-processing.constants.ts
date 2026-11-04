import type { JobsOptions } from 'bullmq';

// Contract of the video-processing queue (### Events/Messages).
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export interface ProcessVideoJobData {
  videoId: string;
}

// 3 attempts with exponential backoff, then the video is marked failed
// (phase-03-videos/TD-07; library-refs.md → bullmq).
export const VIDEO_PROCESSING_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: 1000,
};

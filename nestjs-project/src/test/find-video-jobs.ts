import type { Job, Queue } from 'bullmq';

// Looks a job up in every state: the real video-worker container of the
// Compose stack may pick it up (active/delayed/failed) before the test
// asserts on it.
export async function findVideoJobs(
  queue: Queue,
  videoId: string,
): Promise<Job[]> {
  const jobs = await queue.getJobs([
    'waiting',
    'prioritized',
    'active',
    'delayed',
    'failed',
    'completed',
  ]);
  return jobs.filter(
    (job) => (job.data as { videoId?: string }).videoId === videoId,
  );
}

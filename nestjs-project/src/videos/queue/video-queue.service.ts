import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { VIDEO_JOB_OPTIONS, VIDEO_QUEUE } from '../videos.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue(VIDEO_QUEUE.NAME)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  // Returns the enqueued Job so callers/tests can assert on it without querying
  // queue state — a running worker consumes the job immediately, so inspecting
  // `getWaiting()` after add() would be racy.
  async enqueueProcessing(videoId: string): Promise<Job<ProcessVideoJobData>> {
    return this.queue.add(
      VIDEO_QUEUE.JOB_PROCESS,
      { videoId },
      {
        attempts: VIDEO_JOB_OPTIONS.ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: VIDEO_JOB_OPTIONS.BACKOFF_DELAY_MS,
        },
        removeOnComplete: true,
      },
    );
  }
}

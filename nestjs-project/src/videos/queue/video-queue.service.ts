import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
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

  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
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

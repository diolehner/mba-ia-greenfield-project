import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { VIDEO_JOB_OPTIONS, VIDEO_QUEUE } from '../videos.constants';
import { VideoQueueService } from './video-queue.service';

describe('VideoQueueService', () => {
  let service: VideoQueueService;
  const queueAdd = jest.fn();

  beforeEach(async () => {
    queueAdd.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoQueueService,
        {
          provide: getQueueToken(VIDEO_QUEUE.NAME),
          useValue: { add: queueAdd },
        },
      ],
    }).compile();

    service = moduleRef.get(VideoQueueService);
  });

  it('should enqueue a process-video job with retry and backoff options', async () => {
    await service.enqueueProcessing('video-123');

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      VIDEO_QUEUE.JOB_PROCESS,
      { videoId: 'video-123' },
      {
        attempts: VIDEO_JOB_OPTIONS.ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: VIDEO_JOB_OPTIONS.BACKOFF_DELAY_MS,
        },
        removeOnComplete: true,
      },
    );
  });
});

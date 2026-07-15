import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import redisConfig from '../../config/redis.config';
import { VIDEO_QUEUE } from '../videos.constants';
import { ProcessVideoJobData, VideoQueueService } from './video-queue.service';

describe('VideoQueueService (integration, real Redis)', () => {
  let service: VideoQueueService;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
        BullModule.forRootAsync({
          inject: [redisConfig.KEY],
          useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
            connection: { host: cfg.host, port: cfg.port },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_QUEUE.NAME }),
      ],
      providers: [VideoQueueService],
    }).compile();

    service = moduleRef.get(VideoQueueService);
    queue = moduleRef.get<Queue<ProcessVideoJobData>>(
      getQueueToken(VIDEO_QUEUE.NAME),
    );
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('should enqueue a real job that lands in the queue', async () => {
    await service.enqueueProcessing('video-integration-1');

    const waiting = await queue.getWaiting();
    expect(waiting).toHaveLength(1);
    expect(waiting[0].name).toBe(VIDEO_QUEUE.JOB_PROCESS);
    expect(waiting[0].data).toEqual({ videoId: 'video-integration-1' });
    expect(waiting[0].opts.attempts).toBe(3);
    expect(waiting[0].opts.backoff).toEqual({
      type: 'exponential',
      delay: 2000,
    });
  });
});

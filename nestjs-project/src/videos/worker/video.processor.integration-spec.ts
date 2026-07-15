import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import databaseConfig from '../../config/database.config';
import storageConfig from '../../config/storage.config';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { StorageService } from '../storage/storage.service';
import { Video, VIDEO_STATUS } from '../entities/video.entity';
import { ProcessVideoJobData } from '../queue/video-queue.service';
import { VideoProcessor } from './video.processor';

const execFileAsync = promisify(execFile);

/**
 * Real infra integration: MinIO + PostgreSQL + ffmpeg/ffprobe (installed in the
 * API container via Dockerfile.dev). Generates a real 2s MP4, uploads it to
 * MinIO, creates an `uploaded` Video row, runs the processor, and asserts the
 * video becomes `ready` with a duration and a thumbnail object in storage.
 */
describe('VideoProcessor (integration, real MinIO + ffmpeg)', () => {
  let processor: VideoProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'proc-test-'));

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
        }),
      ],
      providers: [StorageService],
    }).compile();

    storage = moduleRef.get(StorageService);
    await storage.ensureBucket();

    const dbConf = databaseConfig();
    dataSource = new DataSource({
      type: 'postgres',
      host: dbConf.host,
      port: dbConf.port,
      username: dbConf.username,
      password: dbConf.password,
      database: dbConf.name,
      entities: [Video, Channel, User],
      synchronize: false,
    });
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);

    processor = new VideoProcessor(videoRepo, storage);
  });

  afterAll(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('processes an uploaded video to ready with duration and thumbnail', async () => {
    // Arrange: a real channel row (FK) + a real MP4 uploaded to MinIO.
    const channelId = await seedChannel(dataSource);
    const videoId = randomUUID();
    const publicId = randomUUID().slice(0, 12);
    const storageKey = storage.buildSourceKey(channelId, videoId, 'mp4');

    const mp4Path = join(workDir, `${videoId}.mp4`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=15',
      '-pix_fmt',
      'yuv420p',
      mp4Path,
    ]);
    const mp4Buffer = await readFile(mp4Path);
    await storage.putObject(storageKey, mp4Buffer, 'video/mp4');

    await videoRepo.save(
      videoRepo.create({
        id: videoId,
        channelId,
        publicId,
        title: 'Integration test video',
        status: VIDEO_STATUS.UPLOADED,
        storageKey,
        uploadId: null,
      }),
    );

    // Act
    const job = {
      id: 'test-job',
      data: { videoId },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<ProcessVideoJobData>;
    await processor.process(job);

    // Assert: DB state
    const updated = await videoRepo.findOneByOrFail({ id: videoId });
    expect(updated.status).toBe(VIDEO_STATUS.READY);
    expect(updated.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(updated.durationSeconds).toBeLessThanOrEqual(3);
    expect(updated.thumbnailKey).toBeTruthy();
    expect(updated.metadata).toBeTruthy();
    expect(updated.sizeBytes).toBe(String(mp4Buffer.length));

    // Assert: thumbnail object exists in MinIO
    const thumb = await storage.getObjectRange(updated.thumbnailKey as string);
    expect(thumb.contentType).toBe('image/jpeg');
    expect(thumb.contentLength).toBeGreaterThan(0);

    // Cleanup this test's rows
    await videoRepo.delete({ id: videoId });
    await dataSource.query('DELETE FROM "channels" WHERE id = $1', [channelId]);
    await dataSource.query('DELETE FROM "users" WHERE id = $1', [seededUserId]);
  });
});

let seededUserId = '';

async function seedChannel(dataSource: DataSource): Promise<string> {
  const userId = randomUUID();
  seededUserId = userId;
  const channelId = randomUUID();
  const suffix = channelId.slice(0, 8);
  await dataSource.query(
    'INSERT INTO "users" (id, email, password, is_confirmed) VALUES ($1, $2, $3, $4)',
    [userId, `proc-${suffix}@example.com`, 'x', true],
  );
  await dataSource.query(
    'INSERT INTO "channels" (id, name, nickname, user_id) VALUES ($1, $2, $3, $4)',
    [channelId, `proc-${suffix}`, `proc-${suffix}`, userId],
  );
  return channelId;
}

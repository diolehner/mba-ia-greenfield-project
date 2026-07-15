import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { User } from '../src/users/entities/user.entity';
import { Video, VIDEO_STATUS } from '../src/videos/entities/video.entity';
import { StorageService } from '../src/videos/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';

// A tiny, well-known payload so we can assert exact bytes on range/full reads.
const VIDEO_BYTES = Buffer.from('0123456789ABCDEF', 'utf8'); // 16 bytes

describe('Videos public consumption (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storage: StorageService;

  const readyPublicId = 'ready-video1';
  const notReadyPublicId = 'draft-video1';
  const readyStorageKey =
    'channels/test-channel/videos/test-video/source/test-video.mp4';

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = moduleFixture.get(getRepositoryToken(User));
    channelRepository = moduleFixture.get(getRepositoryToken(Channel));
    videoRepository = moduleFixture.get(getRepositoryToken(Video));
    storage = app.get(StorageService);

    await cleanAllTables(dataSource);

    // Seed a channel owner and channel.
    const user = await userRepository.save(
      userRepository.create({
        email: 'consumer-owner@example.com',
        password: 'hash',
        is_confirmed: true,
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Consumer Channel',
        nickname: 'consumer-channel',
        user_id: user.id,
      }),
    );

    // Put the known object into the REAL MinIO under the ready video's key.
    await storage.putObject(readyStorageKey, VIDEO_BYTES, 'video/mp4');

    // A ready video pointing at the seeded object.
    await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        publicId: readyPublicId,
        title: 'My Ready Video',
        status: VIDEO_STATUS.READY,
        storageKey: readyStorageKey,
        mimeType: 'video/mp4',
        sizeBytes: String(VIDEO_BYTES.length),
        durationSeconds: 42,
      }),
    );

    // A not-ready (draft) video — must never be served publicly.
    await videoRepository.save(
      videoRepository.create({
        channelId: channel.id,
        publicId: notReadyPublicId,
        title: 'Still Draft',
        status: VIDEO_STATUS.DRAFT,
        storageKey:
          'channels/test-channel/videos/draft-video/source/draft-video.mp4',
        mimeType: 'video/mp4',
      }),
    );
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await app.close();
  });

  describe('GET /videos/:publicId', () => {
    it('returns 200 with the public shape (no storageKey) for a ready video', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${readyPublicId}`)
        .expect(200);

      expect(res.body.publicId).toBe(readyPublicId);
      expect(res.body.title).toBe('My Ready Video');
      expect(res.body.status).toBe('ready');
      expect(res.body.durationSeconds).toBe(42);
      expect(res.body).not.toHaveProperty('storageKey');
      expect(res.body).not.toHaveProperty('uploadId');
      expect(res.body).not.toHaveProperty('channelId');
    });

    it('returns 404 for a video that is not ready', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${notReadyPublicId}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 404 for an unknown publicId', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/does-not-exist')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('returns 206 with Content-Range and the requested byte slice', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${readyPublicId}/stream`)
        .set('Range', 'bytes=0-4')
        .buffer()
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(206);

      expect(res.headers['content-range']).toBe('bytes 0-4/16');
      expect(res.headers['accept-ranges']).toBe('bytes');
      const body = res.body as Buffer;
      expect(body.length).toBe(5);
      expect(body.toString('utf8')).toBe('01234');
    });

    it('returns 200 with the full object and Accept-Ranges when no Range header is sent', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${readyPublicId}/stream`)
        .buffer()
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['accept-ranges']).toBe('bytes');
      const body = res.body as Buffer;
      expect(body.length).toBe(VIDEO_BYTES.length);
      expect(body.equals(VIDEO_BYTES)).toBe(true);
    });

    it('returns 404 for a not-ready video', async () => {
      await request(app.getHttpServer())
        .get(`/videos/${notReadyPublicId}/stream`)
        .expect(404);
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('returns 200 with a Content-Disposition attachment header', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${readyPublicId}/download`)
        .buffer()
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain(
        'My-Ready-Video.mp4',
      );
      const body = res.body as Buffer;
      expect(body.equals(VIDEO_BYTES)).toBe(true);
    });

    it('returns 404 for a not-ready video', async () => {
      await request(app.getHttpServer())
        .get(`/videos/${notReadyPublicId}/download`)
        .expect(404);
    });
  });
});

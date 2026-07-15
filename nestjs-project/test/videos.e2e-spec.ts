import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VideoQueueService } from '../src/videos/queue/video-queue.service';
import { StorageService } from '../src/videos/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let enqueueSpy: jest.SpyInstance;

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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    // Do not touch the real object storage from the HTTP-level e2e: stub the
    // multipart calls. The processor integration test covers real MinIO.
    const storage = app.get(StorageService);
    jest
      .spyOn(storage, 'createMultipartUpload')
      .mockResolvedValue('upload-e2e-1');
    jest
      .spyOn(storage, 'presignUploadPart')
      .mockImplementation(async (_k, _u, n) => `https://minio.local/part-${n}`);
    jest.spyOn(storage, 'completeMultipart').mockResolvedValue(undefined);
    jest.spyOn(storage, 'abortMultipart').mockResolvedValue(undefined);

    const queue = app.get(VideoQueueService);
    enqueueSpy = jest
      .spyOn(queue, 'enqueueProcessing')
      .mockResolvedValue({ id: 'test-job-id' } as never);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    enqueueSpy.mockClear();
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  describe('POST /videos/uploads', () => {
    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({ title: 'x', partsCount: 1 })
        .expect(401);
    });

    it('returns 201 with the upload envelope for an authenticated owner', async () => {
      const token = await registerConfirmAndLogin('uploader@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'My Video', contentType: 'video/mp4', partsCount: 2 })
        .expect(201);

      expect(res.body.videoId).toBeDefined();
      expect(res.body.publicId).toHaveLength(12);
      expect(res.body.uploadId).toBe('upload-e2e-1');
      expect(res.body.key).toContain('/source/');
      expect(res.body.parts).toHaveLength(2);
      expect(res.body.parts[0]).toEqual({
        partNumber: 1,
        url: 'https://minio.local/part-1',
      });
    });

    it('returns 400 when neither fileSize nor partsCount is provided', async () => {
      const token = await registerConfirmAndLogin('nosize@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'No size' })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when title is missing', async () => {
      const token = await registerConfirmAndLogin('notitle@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ partsCount: 1 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:publicId/uploads/complete', () => {
    async function initiate(token: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'V', contentType: 'video/mp4', partsCount: 1 });
      return res.body.publicId as string;
    }

    it('returns 200, transitions to uploaded, and enqueues processing', async () => {
      const token = await registerConfirmAndLogin('completer@example.com');
      const publicId = await initiate(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag: 'etag-1' }] })
        .expect(200);

      expect(res.body.publicId).toBe(publicId);
      expect(res.body.status).toBe('uploaded');
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it('returns 401 without an access token', async () => {
      const token = await registerConfirmAndLogin('anon-complete@example.com');
      const publicId = await initiate(token);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .send({ parts: [{ partNumber: 1, eTag: 'e' }] })
        .expect(401);
    });

    it('returns 403 when another user tries to complete the upload', async () => {
      const ownerToken = await registerConfirmAndLogin('owner@example.com');
      const publicId = await initiate(ownerToken);
      const otherToken = await registerConfirmAndLogin('intruder@example.com');

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ partNumber: 1, eTag: 'e' }] })
        .expect(403);

      expect(res.body.error).toBe('VIDEO_FORBIDDEN');
    });

    it('returns 404 for an unknown publicId', async () => {
      const token = await registerConfirmAndLogin('notfound@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/does-not-exist/uploads/complete')
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag: 'e' }] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 409 when completing a video that is already uploaded', async () => {
      const token = await registerConfirmAndLogin('doublecomplete@example.com');
      const publicId = await initiate(token);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag: 'etag-1' }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag: 'etag-1' }] })
        .expect(409);

      expect(res.body.error).toBe('INVALID_VIDEO_STATE');
    });
  });
});

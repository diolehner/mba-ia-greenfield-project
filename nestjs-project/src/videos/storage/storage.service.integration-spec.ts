import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../../config/storage.config';
import { StorageService } from './storage.service';

async function drainStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration, real MinIO)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
          ignoreEnvFile: true,
        }),
      ],
      providers: [StorageService],
    }).compile();

    service = moduleRef.get(StorageService);
    await service.ensureBucket();
  });

  it('should ensure the bucket exists (idempotent)', async () => {
    await expect(service.ensureBucket()).resolves.toBeUndefined();
    await expect(service.ensureBucket()).resolves.toBeUndefined();
  });

  it('should run a full multipart upload and read it back via range', async () => {
    const key = `test/${randomUUID()}/multipart.bin`;
    // Single part: S3/MinIO allows the last (and only) part to be < 5MiB.
    const payload = Buffer.from('hello streamtube multipart world');

    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    expect(uploadId).toBeTruthy();

    const url = await service.presignUploadPart(key, uploadId, 1);
    expect(url).toContain(key);

    const putResponse = await fetch(url, { method: 'PUT', body: payload });
    expect(putResponse.ok).toBe(true);
    const eTag = putResponse.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipart(key, uploadId, [
      { partNumber: 1, eTag: eTag as string },
    ]);

    // Full read (no range).
    const full = await service.getObjectRange(key);
    expect(full.contentLength).toBe(payload.length);
    const fullBody = await drainStream(full.stream);
    expect(fullBody.toString()).toBe(payload.toString());

    // Ranged read → should carry a Content-Range and a partial length.
    const ranged = await service.getObjectRange(key, 'bytes=0-4');
    expect(ranged.contentLength).toBe(5);
    expect(ranged.contentRange).toMatch(/^bytes 0-4\/\d+$/);
    const rangedBody = await drainStream(ranged.stream);
    expect(rangedBody.toString()).toBe('hello');
  });

  it('should put and read back a thumbnail object', async () => {
    const channelId = randomUUID();
    const videoId = randomUUID();
    const key = service.buildThumbnailKey(channelId, videoId);
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    await service.putObject(key, body, 'image/jpeg');

    const result = await service.getObjectRange(key);
    expect(result.contentType).toBe('image/jpeg');
    expect(result.contentLength).toBe(body.length);
    const readBack = await drainStream(result.stream);
    expect(readBack.equals(body)).toBe(true);
  });

  it('should abort a multipart upload', async () => {
    const key = `test/${randomUUID()}/aborted.bin`;
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    await expect(
      service.abortMultipart(key, uploadId),
    ).resolves.toBeUndefined();

    // After abort, the object should not exist.
    await expect(service.getObjectRange(key)).rejects.toThrow();
  });

  it('should build source and thumbnail keys per the TD-03 layout', () => {
    expect(service.buildSourceKey('ch1', 'vid1', 'mp4')).toBe(
      'channels/ch1/videos/vid1/source/vid1.mp4',
    );
    expect(service.buildSourceKey('ch1', 'vid1', '.mov')).toBe(
      'channels/ch1/videos/vid1/source/vid1.mov',
    );
    expect(service.buildThumbnailKey('ch1', 'vid1')).toBe(
      'channels/ch1/videos/vid1/thumbnails/vid1.jpg',
    );
  });
});

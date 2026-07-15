import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  VideoForbiddenException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { VideoQueueService } from './queue/video-queue.service';
import { StorageService } from './storage/storage.service';
import { Video, VIDEO_STATUS } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let channelRepo: { findOne: jest.Mock };
  let storage: {
    buildSourceKey: jest.Mock;
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    completeMultipart: jest.Mock;
    abortMultipart: jest.Mock;
  };
  let queue: { enqueueProcessing: jest.Mock };

  const USER_ID = 'user-1';
  const CHANNEL = { id: 'channel-1', user_id: USER_ID } as Channel;

  beforeEach(async () => {
    videoRepo = {
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => v),
      findOne: jest.fn(),
    };
    channelRepo = { findOne: jest.fn() };
    storage = {
      buildSourceKey: jest.fn(
        () => 'channels/channel-1/videos/vid/source/vid.mp4',
      ),
      createMultipartUpload: jest.fn(async () => 'upload-123'),
      presignUploadPart: jest.fn(
        async (_k, _u, n) => `https://minio/part-${n}`,
      ),
      completeMultipart: jest.fn(async () => undefined),
      abortMultipart: jest.fn(async () => undefined),
    };
    queue = { enqueueProcessing: jest.fn(async () => undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepo },
        { provide: getRepositoryToken(Channel), useValue: channelRepo },
        { provide: StorageService, useValue: storage },
        { provide: VideoQueueService, useValue: queue },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('creates a draft video, opens multipart, and returns presigned parts', async () => {
      channelRepo.findOne.mockResolvedValue(CHANNEL);

      const result = await service.initiateUpload(USER_ID, {
        title: 'My video',
        contentType: 'video/mp4',
        partsCount: 3,
      });

      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        expect.any(String),
        'video/mp4',
      );
      expect(storage.presignUploadPart).toHaveBeenCalledTimes(3);
      expect(result.uploadId).toBe('upload-123');
      expect(result.parts).toHaveLength(3);
      expect(result.parts[0]).toEqual({
        partNumber: 1,
        url: 'https://minio/part-1',
      });
      expect(result.publicId).toHaveLength(12);

      const saved = videoRepo.save.mock.calls[0][0];
      expect(saved.status).toBe(VIDEO_STATUS.DRAFT);
      expect(saved.uploadId).toBe('upload-123');
      expect(saved.channelId).toBe(CHANNEL.id);
    });

    it('derives parts count from fileSize (64MiB target)', async () => {
      channelRepo.findOne.mockResolvedValue(CHANNEL);

      await service.initiateUpload(USER_ID, {
        title: 'Big',
        fileSize: 200 * 1024 * 1024, // 200 MiB -> ceil(200/64) = 4 parts
      });

      expect(storage.presignUploadPart).toHaveBeenCalledTimes(4);
    });

    it('throws ChannelNotFoundException (403) when user has no channel', async () => {
      channelRepo.findOne.mockResolvedValue(null);

      await expect(
        service.initiateUpload(USER_ID, { title: 'x', partsCount: 1 }),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
    });
  });

  describe('completeUpload', () => {
    const draftVideo = (): Video =>
      ({
        id: 'vid-1',
        publicId: 'pub123456789',
        channelId: CHANNEL.id,
        status: VIDEO_STATUS.DRAFT,
        storageKey: 'channels/channel-1/videos/vid-1/source/vid-1.mp4',
        uploadId: 'upload-123',
      }) as Video;

    it('completes multipart, sets uploaded, and enqueues processing', async () => {
      channelRepo.findOne.mockResolvedValue(CHANNEL);
      videoRepo.findOne.mockResolvedValue(draftVideo());

      const result = await service.completeUpload(USER_ID, 'pub123456789', {
        parts: [{ partNumber: 1, eTag: 'etag-1' }],
      });

      expect(storage.completeMultipart).toHaveBeenCalled();
      expect(queue.enqueueProcessing).toHaveBeenCalledWith('vid-1');
      expect(result.status).toBe(VIDEO_STATUS.UPLOADED);
      const saved = videoRepo.save.mock.calls[0][0];
      expect(saved.status).toBe(VIDEO_STATUS.UPLOADED);
      expect(saved.uploadId).toBeNull();
    });

    it('aborts multipart and keeps draft when complete fails (compensation)', async () => {
      channelRepo.findOne.mockResolvedValue(CHANNEL);
      videoRepo.findOne.mockResolvedValue(draftVideo());
      storage.completeMultipart.mockRejectedValue(new Error('boom'));

      await expect(
        service.completeUpload(USER_ID, 'pub123456789', {
          parts: [{ partNumber: 1, eTag: 'etag-1' }],
        }),
      ).rejects.toThrow('boom');

      expect(storage.abortMultipart).toHaveBeenCalledWith(
        expect.any(String),
        'upload-123',
      );
      expect(queue.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('throws VideoNotFoundException (404) for unknown publicId', async () => {
      channelRepo.findOne.mockResolvedValue(CHANNEL);
      videoRepo.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER_ID, 'missing', {
          parts: [{ partNumber: 1, eTag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws VideoForbiddenException (403) when video belongs to another channel', async () => {
      channelRepo.findOne.mockResolvedValue(CHANNEL);
      videoRepo.findOne.mockResolvedValue({
        ...draftVideo(),
        channelId: 'other-channel',
      } as Video);

      await expect(
        service.completeUpload(USER_ID, 'pub123456789', {
          parts: [{ partNumber: 1, eTag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(VideoForbiddenException);
    });

    it('throws InvalidVideoStateException (409) when video is not draft', async () => {
      channelRepo.findOne.mockResolvedValue(CHANNEL);
      videoRepo.findOne.mockResolvedValue({
        ...draftVideo(),
        status: VIDEO_STATUS.UPLOADED,
      } as Video);

      await expect(
        service.completeUpload(USER_ID, 'pub123456789', {
          parts: [{ partNumber: 1, eTag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });
  });
});

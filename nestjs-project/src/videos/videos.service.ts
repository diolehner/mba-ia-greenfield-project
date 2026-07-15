import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { nanoid } from 'nanoid';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  VideoForbiddenException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { VideoQueueService } from './queue/video-queue.service';
import { ObjectRangeResult, StorageService } from './storage/storage.service';
import { PublicVideo, Video, VIDEO_STATUS } from './entities/video.entity';
import { VIDEO_UPLOAD } from './videos.constants';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';

const PUBLIC_ID_LENGTH = 12;

export interface InitiateUploadResult {
  videoId: string;
  publicId: string;
  uploadId: string;
  key: string;
  parts: { partNumber: number; url: string }[];
}

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
};

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.getOwnedChannel(userId);

    const contentType = dto.contentType ?? VIDEO_UPLOAD.DEFAULT_CONTENT_TYPE;
    const partsCount = this.resolvePartsCount(dto);

    const videoId = randomUUID();
    const publicId = nanoid(PUBLIC_ID_LENGTH);
    const ext = this.resolveExtension(contentType);
    const storageKey = this.storageService.buildSourceKey(
      channel.id,
      videoId,
      ext,
    );

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      contentType,
    );

    const parts = await Promise.all(
      Array.from({ length: partsCount }, (_, i) => i + 1).map(
        async (partNumber) => ({
          partNumber,
          url: await this.storageService.presignUploadPart(
            storageKey,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );

    const video = this.videoRepository.create({
      id: videoId,
      channelId: channel.id,
      publicId,
      title: dto.title,
      status: VIDEO_STATUS.DRAFT,
      storageKey,
      uploadId,
      mimeType: contentType,
    });
    await this.videoRepository.save(video);

    return { videoId, publicId, uploadId, key: storageKey, parts };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<{ publicId: string; status: string }> {
    const channel = await this.getOwnedChannel(userId);
    const video = await this.getVideoByPublicId(publicId);

    if (video.channelId !== channel.id) {
      throw new VideoForbiddenException();
    }
    if (video.status !== VIDEO_STATUS.DRAFT) {
      throw new InvalidVideoStateException(
        `Video is in status "${video.status}", expected "draft"`,
      );
    }
    if (!video.uploadId) {
      throw new InvalidVideoStateException(
        'Video has no in-progress multipart upload',
      );
    }

    try {
      await this.storageService.completeMultipart(
        video.storageKey,
        video.uploadId,
        dto.parts,
      );
    } catch (err) {
      // Compensation: abort the multipart upload and keep the video as draft
      // so the client can retry the upload.
      await this.storageService.abortMultipart(
        video.storageKey,
        video.uploadId,
      );
      throw err;
    }

    video.status = VIDEO_STATUS.UPLOADED;
    video.uploadId = null;
    await this.videoRepository.save(video);

    await this.videoQueueService.enqueueProcessing(video.id);

    return { publicId: video.publicId, status: video.status };
  }

  /**
   * Public metadata for a video. Only `ready` videos are exposed — anything
   * else (draft/uploaded/processing/failed) or an unknown publicId surfaces as
   * a 404 so we never leak the existence of not-yet-published videos.
   */
  async getPublicVideo(publicId: string): Promise<PublicVideo> {
    const video = await this.getReadyVideo(publicId);
    return video.toPublic();
  }

  /**
   * Opens a stream of the source object for a `ready` video, delegating the
   * `Range` header handling to the storage layer. The domain lookup/validation
   * runs (and throws) BEFORE any byte is read from storage, so the global
   * exception filter can still map errors to a clean JSON response.
   */
  async openVideoStream(
    publicId: string,
    range?: string,
  ): Promise<ObjectRangeResult> {
    const video = await this.getReadyVideo(publicId);
    return this.storageService.getObjectRange(video.storageKey, range);
  }

  /**
   * Opens a full-object stream for a `ready` video plus the download file name
   * derived from the title (or publicId) and the source extension.
   */
  async openVideoDownload(
    publicId: string,
  ): Promise<{ object: ObjectRangeResult; fileName: string }> {
    const video = await this.getReadyVideo(publicId);
    const object = await this.storageService.getObjectRange(video.storageKey);
    return { object, fileName: this.buildDownloadFileName(video) };
  }

  private buildDownloadFileName(video: Video): string {
    const ext = this.extractExtension(video.storageKey);
    const base = this.slugifyFileName(video.title) || video.publicId;
    return ext ? `${base}.${ext}` : base;
  }

  private extractExtension(storageKey: string): string {
    const match = /\.([a-z0-9]+)$/i.exec(storageKey);
    return match ? match[1] : '';
  }

  private slugifyFileName(value: string): string {
    return value
      .trim()
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 100);
  }

  private async getReadyVideo(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { publicId } });
    if (!video || video.status !== VIDEO_STATUS.READY) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async getOwnedChannel(userId: string): Promise<Channel> {
    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) {
      throw new ChannelNotFoundException();
    }
    return channel;
  }

  private async getVideoByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { publicId } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private resolvePartsCount(dto: InitiateUploadDto): number {
    if (dto.partsCount !== undefined) {
      return dto.partsCount;
    }
    if (dto.fileSize !== undefined) {
      const count = Math.ceil(
        dto.fileSize / VIDEO_UPLOAD.TARGET_PART_SIZE_BYTES,
      );
      return Math.min(Math.max(count, 1), VIDEO_UPLOAD.MAX_PARTS);
    }
    throw new InvalidVideoStateException(
      'Either fileSize or partsCount must be provided',
    );
  }

  private resolveExtension(contentType: string): string {
    return CONTENT_TYPE_TO_EXT[contentType.toLowerCase()] ?? 'mp4';
  }
}

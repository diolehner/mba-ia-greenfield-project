import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Readable } from 'stream';
import storageConfig from '../../config/storage.config';

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface ObjectRangeResult {
  stream: Readable;
  contentRange: string | undefined;
  contentLength: number | undefined;
  contentType: string | undefined;
  eTag: string | undefined;
}

const PRESIGN_DEFAULT_EXPIRES_SECONDS = 3600;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const statusCode = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      if (statusCode === 404 || statusCode === 400) {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
        this.logger.log(`Created bucket "${this.bucket}"`);
        return;
      }
      throw err;
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error(`MinIO did not return an UploadId for key "${key}"`);
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = PRESIGN_DEFAULT_EXPIRES_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const orderedParts = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => ({ ETag: part.eTag, PartNumber: part.partNumber }));

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: orderedParts },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async getObjectRange(
    key: string,
    range?: string,
  ): Promise<ObjectRangeResult> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range && { Range: range }),
      }),
    );

    return {
      stream: result.Body as Readable,
      contentRange: result.ContentRange,
      contentLength: result.ContentLength,
      contentType: result.ContentType,
      eTag: result.ETag,
    };
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Source object key — layout `channels/{channelId}/videos/{videoId}/source/{videoId}.{ext}` (TD-03).
   */
  buildSourceKey(channelId: string, videoId: string, ext: string): string {
    const normalizedExt = ext.replace(/^\./, '');
    return `channels/${channelId}/videos/${videoId}/source/${videoId}.${normalizedExt}`;
  }

  /**
   * Thumbnail object key — layout `channels/{channelId}/videos/{videoId}/thumbnails/{videoId}.jpg` (TD-03).
   */
  buildThumbnailKey(channelId: string, videoId: string): string {
    return `channels/${channelId}/videos/${videoId}/thumbnails/${videoId}.jpg`;
  }
}

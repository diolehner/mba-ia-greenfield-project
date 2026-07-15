import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { PublicVideo } from './entities/video.entity';
import { InitiateUploadResult, VideosService } from './videos.service';

const DEFAULT_STREAM_CONTENT_TYPE = 'application/octet-stream';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Creates a draft video owned by the authenticated user's channel, opens a multipart upload on the object storage, and returns presigned URLs the client uses to upload each part directly.",
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        publicId: { type: 'string' },
        uploadId: { type: 'string' },
        key: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own a channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/uploads/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload for a draft video, transitions it to `uploaded`, and enqueues asynchronous processing (metadata extraction + thumbnail).',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        publicId: { type: 'string' },
        status: { type: 'string', example: 'uploaded' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own the video/channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a valid state to complete the upload',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ publicId: string; status: string }> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @Get(':publicId')
  @Public()
  @ApiOperation({
    summary: 'Get public video metadata',
    description:
      'Returns the public metadata of a `ready` video. Videos that are not yet ready (or unknown) return 404 so their existence is not leaked.',
  })
  @ApiResponse({
    status: 200,
    description: 'Public video metadata',
    schema: {
      properties: {
        publicId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'ready' },
        thumbnailKey: { type: 'string', nullable: true },
        mimeType: { type: 'string', nullable: true },
        sizeBytes: { type: 'string', nullable: true },
        durationSeconds: { type: 'integer', nullable: true },
        metadata: { type: 'object', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPublicVideo(
    @Param('publicId') publicId: string,
  ): Promise<PublicVideo> {
    return this.videosService.getPublicVideo(publicId);
  }

  @Get(':publicId/stream')
  @Public()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Streams the video bytes. Honours the HTTP `Range` header: with a valid range it responds 206 Partial Content plus `Content-Range`; without a range it responds 200 with the full object. Only `ready` videos are served.',
  })
  @ApiResponse({ status: 200, description: 'Full object stream' })
  @ApiResponse({ status: 206, description: 'Partial content (range request)' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('publicId') publicId: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    // The domain lookup/validation happens inside the service and throws BEFORE
    // any byte is written to `res`, so the global DomainExceptionFilter can
    // still produce a clean JSON error response for not-found/not-ready videos.
    const object = await this.videosService.openVideoStream(publicId, range);

    const contentType = object.contentType ?? DEFAULT_STREAM_CONTENT_TYPE;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength);
    }

    if (range) {
      // A range was requested and honoured by storage → 206 Partial Content.
      if (object.contentRange) {
        res.setHeader('Content-Range', object.contentRange);
      }
      res.status(HttpStatus.PARTIAL_CONTENT);
    } else {
      res.status(HttpStatus.OK);
    }

    object.stream.pipe(res);
  }

  @Get(':publicId/download')
  @Public()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Streams the full video object with a `Content-Disposition: attachment` header so browsers download it as a file. Only `ready` videos are served.',
  })
  @ApiResponse({ status: 200, description: 'Video file download' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @Param('publicId') publicId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const { object, fileName } =
      await this.videosService.openVideoDownload(publicId);

    const contentType = object.contentType ?? DEFAULT_STREAM_CONTENT_TYPE;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength);
    }

    res.status(HttpStatus.OK);
    object.stream.pipe(res);
  }
}

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VIDEO_STATUS } from '../entities/video.entity';
import { ProcessVideoJobData } from '../queue/video-queue.service';
import {
  THUMBNAIL_CONTENT_TYPE,
  VIDEO_JOB_OPTIONS,
  VIDEO_QUEUE,
} from '../videos.constants';

const execFileAsync = promisify(execFile);

const THUMBNAIL_TIMESTAMP_SECONDS = 1;

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

interface FfprobeResult {
  format?: { duration?: string; [key: string]: unknown };
  streams?: FfprobeStream[];
}

@Processor(VIDEO_QUEUE.NAME)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }

    video.status = VIDEO_STATUS.PROCESSING;
    await this.videoRepository.save(video);

    const workDir = await mkdtemp(join(tmpdir(), 'video-'));
    const ext = this.extensionFromKey(video.storageKey);
    const sourcePath = join(workDir, `source.${ext}`);
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.downloadSource(video.storageKey, sourcePath);

      const probe = await this.probe(sourcePath);
      const durationSeconds = this.extractDuration(probe);

      await this.generateThumbnail(sourcePath, thumbnailPath);
      const thumbnailBuffer = await readFile(thumbnailPath);
      const thumbnailKey = this.storageService.buildThumbnailKey(
        video.channelId,
        video.id,
      );
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        THUMBNAIL_CONTENT_TYPE,
      );

      const sizeBytes = await this.sourceSize(video.storageKey);

      video.status = VIDEO_STATUS.READY;
      video.durationSeconds = durationSeconds;
      video.metadata = probe as unknown as Record<string, unknown>;
      video.thumbnailKey = thumbnailKey;
      video.sizeBytes = sizeBytes;
      video.failureReason = null;
      await this.videoRepository.save(video);

      this.logger.log(`Video ${videoId} processed successfully`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, err: Error): Promise<void> {
    // Background task: log and mark the video as failed only after all retry
    // attempts have been exhausted. Never rethrow — that would crash the worker.
    const exhausted =
      job.attemptsMade >= (job.opts.attempts ?? VIDEO_JOB_OPTIONS.ATTEMPTS);
    this.logger.error(
      `Job ${job.id} for video ${job.data?.videoId} failed (attempt ${job.attemptsMade}): ${err.message}`,
    );
    if (!exhausted) {
      return;
    }

    try {
      await this.videoRepository.update(
        { id: job.data.videoId },
        {
          status: VIDEO_STATUS.FAILED,
          failureReason: err.message.slice(0, 500),
        },
      );
    } catch (updateErr) {
      this.logger.error(
        `Failed to mark video ${job.data?.videoId} as failed: ${
          (updateErr as Error).message
        }`,
      );
    }
  }

  private async downloadSource(key: string, destPath: string): Promise<void> {
    const { stream } = await this.storageService.getObjectRange(key);
    await pipeline(stream, createWriteStream(destPath));
  }

  private async sourceSize(key: string): Promise<string | null> {
    const { contentLength } = await this.storageService.getObjectRange(key);
    return contentLength !== undefined ? String(contentLength) : null;
  }

  private async probe(inputPath: string): Promise<FfprobeResult> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ]);
    return JSON.parse(stdout) as FfprobeResult;
  }

  private async generateThumbnail(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      String(THUMBNAIL_TIMESTAMP_SECONDS),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outputPath,
    ]);
  }

  private extractDuration(probe: FfprobeResult): number | null {
    const raw = probe.format?.duration;
    if (!raw) {
      return null;
    }
    const parsed = Math.round(Number(raw));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private extensionFromKey(key: string): string {
    const match = /\.([a-z0-9]+)$/i.exec(key);
    return match ? match[1] : 'mp4';
  }
}

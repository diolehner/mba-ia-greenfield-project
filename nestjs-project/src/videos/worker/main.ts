import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VideoWorkerModule } from './video-worker.module';

/**
 * Standalone entrypoint for the video-processing worker. Runs no HTTP server;
 * the BullMQ `@Processor` inside `VideoWorkerModule` begins consuming jobs as
 * soon as the application context is created.
 *
 * We call `enableShutdownHooks()` (NOT `app.close()`) so the process keeps
 * running and closes the Worker / Redis connections cleanly on SIGINT/SIGTERM.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(VideoWorkerModule);
  app.enableShutdownHooks();
  Logger.log('Video worker started — consuming "video-processing"', 'Worker');
}

void bootstrap();

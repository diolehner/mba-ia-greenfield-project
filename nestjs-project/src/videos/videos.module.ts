import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './queue/video-queue.service';
import { StorageModule } from './storage/storage.module';
import { VIDEO_QUEUE } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_QUEUE.NAME }),
    StorageModule,
  ],
  providers: [VideoQueueService],
  exports: [TypeOrmModule, StorageModule, VideoQueueService],
})
export class VideosModule {}

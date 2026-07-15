import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './queue/video-queue.service';
import { StorageModule } from './storage/storage.module';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_QUEUE } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    BullModule.registerQueue({ name: VIDEO_QUEUE.NAME }),
    StorageModule,
  ],
  controllers: [VideosController],
  providers: [VideoQueueService, VideosService],
  exports: [TypeOrmModule, StorageModule, VideoQueueService],
})
export class VideosModule {}

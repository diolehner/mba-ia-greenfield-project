import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../../config/database.config';
import redisConfig from '../../config/redis.config';
import storageConfig from '../../config/storage.config';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../entities/video.entity';
import { VIDEO_QUEUE } from '../videos.constants';
import { VideoProcessor } from './video.processor';

/**
 * Standalone module for the video-processing worker. It boots without an HTTP
 * server (see `main.ts`); the `@Processor` starts consuming jobs as soon as the
 * application context is created.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig, storageConfig],
    }),
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_QUEUE.NAME }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // Video relates to Channel (→ User); all three must be registered so
    // TypeORM can build the full relation metadata graph.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
  ],
  providers: [VideoProcessor],
})
export class VideoWorkerModule {}

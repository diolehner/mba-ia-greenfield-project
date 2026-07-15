import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export const VIDEO_STATUS = {
  DRAFT: 'draft',
  UPLOADED: 'uploaded',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
} as const;

export type VideoStatus = (typeof VIDEO_STATUS)[keyof typeof VIDEO_STATUS];

export interface PublicVideo {
  publicId: string;
  title: string;
  status: VideoStatus;
  thumbnailKey: string | null;
  mimeType: string | null;
  sizeBytes: string | null;
  durationSeconds: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channelId: string;

  @Column({ type: 'varchar', unique: true })
  publicId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({
    type: 'enum',
    enum: VIDEO_STATUS,
    enumName: 'videos_status_enum',
    default: VIDEO_STATUS.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar' })
  storageKey: string;

  @Column({ type: 'varchar', nullable: true })
  thumbnailKey: string | null;

  @Column({ type: 'varchar', nullable: true })
  uploadId: string | null;

  @Column({ type: 'varchar', nullable: true })
  mimeType: string | null;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes: string | null;

  @Column({ type: 'int', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  failureReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel: Channel;

  /**
   * Public serialization — never exposes internal storage keys, the multipart
   * uploadId, the sequential PK, or the owning channelId.
   */
  toPublic(): PublicVideo {
    return {
      publicId: this.publicId,
      title: this.title,
      status: this.status,
      thumbnailKey: this.thumbnailKey,
      mimeType: this.mimeType,
      sizeBytes: this.sizeBytes,
      durationSeconds: this.durationSeconds,
      metadata: this.metadata,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

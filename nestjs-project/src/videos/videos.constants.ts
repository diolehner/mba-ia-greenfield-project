export const VIDEO_QUEUE = {
  NAME: 'video-processing',
  JOB_PROCESS: 'process-video',
} as const;

export const VIDEO_JOB_OPTIONS = {
  ATTEMPTS: 3,
  BACKOFF_DELAY_MS: 2000,
} as const;

export const VIDEO_UPLOAD = {
  /** Target size of each multipart part when deriving from fileSize (64 MiB). */
  TARGET_PART_SIZE_BYTES: 64 * 1024 * 1024,
  /** S3/MinIO minimum part size (5 MiB) — only the last part may be smaller. */
  MIN_PART_SIZE_BYTES: 5 * 1024 * 1024,
  /** S3/MinIO hard limit on the number of parts in a single multipart upload. */
  MAX_PARTS: 10000,
  /** Fallback content type when the client does not provide one. */
  DEFAULT_CONTENT_TYPE: 'video/mp4',
} as const;

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

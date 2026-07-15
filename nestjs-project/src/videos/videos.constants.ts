export const VIDEO_QUEUE = {
  NAME: 'video-processing',
  JOB_PROCESS: 'process-video',
} as const;

export const VIDEO_JOB_OPTIONS = {
  ATTEMPTS: 3,
  BACKOFF_DELAY_MS: 2000,
} as const;

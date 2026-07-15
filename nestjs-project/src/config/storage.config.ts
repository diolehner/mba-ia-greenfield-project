import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.MINIO_ENDPOINT || 'http://minio:9000',
  accessKey: process.env.MINIO_ACCESS_KEY || 'streamtube',
  secretKey: process.env.MINIO_SECRET_KEY || 'streamtube',
  bucket: process.env.MINIO_BUCKET || 'videos',
  region: process.env.MINIO_REGION || 'us-east-1',
}));

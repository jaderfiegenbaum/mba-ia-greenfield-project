import { registerAs } from '@nestjs/config';

// S3-compatible object storage (MinIO locally, AWS S3 in production).
// `endpoint` is used for server-side calls inside the Compose network;
// `publicEndpoint` is used only to sign presigned URLs handed to clients
// (phase-03-videos/TD-09).
export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT as string,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT as string,
  region: process.env.S3_REGION as string,
  accessKey: process.env.S3_ACCESS_KEY as string,
  secretKey: process.env.S3_SECRET_KEY as string,
  bucket: process.env.S3_BUCKET as string,
}));

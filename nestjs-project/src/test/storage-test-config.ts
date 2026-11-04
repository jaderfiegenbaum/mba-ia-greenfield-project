import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';

// Storage config for tests running inside the Compose network: presigned
// URLs must be reachable from the test process, so the "public" endpoint is
// the internal one (the real public endpoint is only reachable from the host).
export function storageTestConfig(): ConfigType<typeof storageConfig> {
  const endpoint = process.env.S3_ENDPOINT ?? 'http://minio:9000';
  return {
    endpoint,
    publicEndpoint: endpoint,
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY ?? 'streamtube',
    secretKey: process.env.S3_SECRET_KEY ?? 'streamtube-secret',
    bucket: process.env.S3_BUCKET ?? 'streamtube-videos',
  };
}

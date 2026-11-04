import queueConfig from './queue.config';
import storageConfig from './storage.config';

describe('storageConfig / queueConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('maps S3_* env vars to the storage namespace, keeping internal and public endpoints apart', () => {
    process.env.S3_ENDPOINT = 'http://minio:9000';
    process.env.S3_PUBLIC_ENDPOINT = 'http://localhost:9000';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ACCESS_KEY = 'access';
    process.env.S3_SECRET_KEY = 'secret';
    process.env.S3_BUCKET = 'streamtube-videos';

    expect(storageConfig()).toEqual({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKey: 'access',
      secretKey: 'secret',
      bucket: 'streamtube-videos',
    });
  });

  it('maps REDIS_* env vars to the queue namespace with a numeric port', () => {
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6380';

    expect(queueConfig()).toEqual({ host: 'redis', port: 6380 });
  });

  it('defaults the queue port to 6379 when REDIS_PORT is not set', () => {
    process.env.REDIS_HOST = 'redis';
    delete process.env.REDIS_PORT;

    expect(queueConfig().port).toBe(6379);
  });
});

import { StorageService } from './storage.service';
import { createStorageService } from '../test/storage-test-module';

describe('StorageService', () => {
  const config = {
    endpoint: 'http://minio:9000',
    publicEndpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKey: 'access',
    secretKey: 'secret',
    bucket: 'streamtube-videos',
  };
  let service: StorageService;

  beforeEach(async () => {
    service = await createStorageService(config);
  });

  it('should sign part upload URLs with the public endpoint host', async () => {
    const url = new URL(
      await service.presignUploadPart('videos/1/original', 'upload-1', 2, 60),
    );

    expect(url.host).toBe('localhost:9000');
    expect(url.pathname).toBe('/streamtube-videos/videos/1/original');
    expect(url.searchParams.get('partNumber')).toBe('2');
    expect(url.searchParams.get('uploadId')).toBe('upload-1');
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
  });

  it('should sign GET URLs with the public endpoint host and the requested TTL', async () => {
    const url = new URL(
      await service.presignGet('videos/1/original', { expiresIn: 3600 }),
    );

    expect(url.host).toBe('localhost:9000');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.has('response-content-disposition')).toBe(false);
  });

  it('should force an attachment disposition when a download file name is given', async () => {
    const url = new URL(
      await service.presignGet('videos/1/original', {
        expiresIn: 3600,
        downloadFileName: 'my "clip".mp4',
      }),
    );

    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="my _clip_.mp4"',
    );
  });

  it('should sign internal GET URLs with the internal endpoint host', async () => {
    const url = new URL(
      await service.presignInternalGet('videos/1/original', 900),
    );

    expect(url.host).toBe('minio:9000');
  });
});

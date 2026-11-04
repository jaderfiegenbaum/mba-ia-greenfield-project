import { randomBytes, randomUUID } from 'node:crypto';
import { StorageInvalidPartsError } from './storage.errors';
import { StorageService } from './storage.service';
import { createStorageService } from '../test/storage-test-module';

const MiB = 1024 * 1024;

describe('StorageService (integration)', () => {
  let service: StorageService;
  let key: string;

  beforeAll(async () => {
    service = await createStorageService();
  });

  beforeEach(() => {
    key = `test/${randomUUID()}/original`;
  });

  async function uploadPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag as string;
  }

  it('should assemble an object uploaded in parts through presigned URLs', async () => {
    const part1 = randomBytes(5 * MiB);
    const part2 = randomBytes(1 * MiB);
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const etag1 = await uploadPart(
      await service.presignUploadPart(key, uploadId, 1, 300),
      part1,
    );
    const etag2 = await uploadPart(
      await service.presignUploadPart(key, uploadId, 2, 300),
      part2,
    );
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);

    expect(await service.headObjectSize(key)).toBe(part1.length + part2.length);
  });

  it('should list the parts already uploaded', async () => {
    const body = randomBytes(1024);
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const etag = await uploadPart(
      await service.presignUploadPart(key, uploadId, 1, 300),
      body,
    );

    const parts = await service.listParts(key, uploadId);

    expect(parts).toEqual([{ partNumber: 1, etag, size: body.length }]);
  });

  it('should raise StorageInvalidPartsError for an invalid ETag', async () => {
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    await uploadPart(
      await service.presignUploadPart(key, uploadId, 1, 300),
      randomBytes(1024),
    );

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(StorageInvalidPartsError);
  });

  it('should store an object and serve it through an internal presigned URL', async () => {
    const body = Buffer.from('thumbnail-bytes');
    await service.putObject(key, body, 'image/jpeg');

    const response = await fetch(await service.presignInternalGet(key, 60));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  });

  it('should serve a download URL with attachment disposition', async () => {
    await service.putObject(key, Buffer.from('video'), 'video/mp4');

    const response = await fetch(
      await service.presignGet(key, {
        expiresIn: 60,
        downloadFileName: 'clip.mp4',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.mp4"',
    );
  });
});

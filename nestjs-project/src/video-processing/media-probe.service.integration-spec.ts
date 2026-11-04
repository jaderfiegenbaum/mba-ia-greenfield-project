import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Test } from '@nestjs/testing';
import { StorageService } from '../storage/storage.service';
import { createStorageService } from '../test/storage-test-module';
import { createSyntheticVideo } from '../test/synthetic-video';
import { MediaProbeError } from './media-probe.errors';
import { MediaProbeService } from './media-probe.service';

describe('MediaProbeService (integration)', () => {
  let probe: MediaProbeService;
  let storage: StorageService;
  let videoUrl: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [MediaProbeService],
    }).compile();
    probe = module.get(MediaProbeService);
    storage = await createStorageService();

    const key = `test/${randomUUID()}/original`;
    await storage.putObject(key, await createSyntheticVideo(), 'video/mp4');
    videoUrl = await storage.presignInternalGet(key, 300);
  }, 60000);

  it('should extract duration and metadata over HTTP', async () => {
    const result = await probe.probe(videoUrl);

    expect(result.durationSeconds).toBeGreaterThan(3.9);
    expect(result.durationSeconds).toBeLessThan(4.1);
    expect(result.metadata).toMatchObject({
      width: 640,
      height: 360,
      videoCodec: 'h264',
      audioCodec: 'aac',
      frameRate: 25,
    });
    expect(result.metadata.formatName).toContain('mp4');
  });

  it('should capture a 1280px wide JPEG thumbnail', async () => {
    const jpeg = await probe.captureThumbnail(videoUrl, 4);

    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    const thumbKey = `test/${randomUUID()}/thumbnail.jpg`;
    await storage.putObject(thumbKey, jpeg, 'image/jpeg');
    const { stdout } = await promisify(execFile)('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      await storage.presignInternalGet(thumbKey, 60),
    ]);
    expect(stdout.trim()).toBe('1280,720');
  });

  it('should reject a file that is not a video', async () => {
    const key = `test/${randomUUID()}/original`;
    await storage.putObject(key, Buffer.from('just some text'), 'text/plain');

    await expect(
      probe.probe(await storage.presignInternalGet(key, 60)),
    ).rejects.toBeInstanceOf(MediaProbeError);
  });
});

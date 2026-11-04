import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import type { VideoDetailsResponseDto } from '../src/videos/dto/video-details-response.dto';
import type { VideoUploadResponseDto } from '../src/videos/dto/video-upload-response.dto';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { createSyntheticVideo } from '../src/test/synthetic-video';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  bootstrapVideosApp,
  createUserWithToken,
  type VideosE2eContext,
} from './videos-e2e.helpers';

const detailsBody = (res: Response) => res.body as VideoDetailsResponseDto;
const errorBody = (res: Response) => res.body as ApiErrorEnvelope;

describe('videos-playback', () => {
  let context: VideosE2eContext;
  let token: string;
  let userId: string;
  let video: Buffer;

  const http = () => request(context.app.getHttpServer());

  beforeAll(async () => {
    context = await bootstrapVideosApp();
    // Processing is done by the real video-worker container of the Compose
    // stack; make sure the queue is consumable.
    await context.queue.resume();
    video = await createSyntheticVideo({ seconds: 4, width: 640, height: 360 });
  }, 60000);

  afterAll(async () => {
    await cleanAllTables(context.dataSource);
    await context.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(context.dataSource);
    context.throttlerStorage.storage.clear();
    ({ token, userId } = await createUserWithToken(context));
  });

  async function uploadAndWaitUntilReady(): Promise<string> {
    const created = await http()
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Playback clip',
        fileName: 'clip.mp4',
        fileSize: video.length,
        contentType: 'video/mp4',
      });
    expect(created.status).toBe(201);
    const draft = created.body as VideoUploadResponseDto;
    const publicId = draft.publicId;

    const put = await fetch(draft.upload.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(video),
    });
    expect(put.status).toBe(200);
    const completed = await http()
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag: put.headers.get('etag') }] });
    expect(completed.status).toBe(202);

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const { status } = detailsBody(await http().get(`/videos/${publicId}`));
      if (status === VideoStatus.READY) return publicId;
      if (status === VideoStatus.FAILED) {
        throw new Error(`Processing failed for ${publicId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Video ${publicId} did not become ready in 60s`);
  }

  // 1. Fluxo completo até `ready` e reprodução

  it('ready-video-details-are-public', async () => {
    const publicId = await uploadAndWaitUntilReady();

    const response = await http().get(`/videos/${publicId}`);

    expect(response.status).toBe(200);
    const details = detailsBody(response);
    expect(details.status).toBe('ready');
    expect(details.durationSeconds).toBeGreaterThan(3.9);
    expect(details.durationSeconds).toBeLessThan(4.1);
    expect(details.metadata?.width).toBe(640);
    expect(details.metadata?.height).toBe(360);
    expect(details.thumbnailUrl).toBeTruthy();
    const thumbnail = await fetch(details.thumbnailUrl as string);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  }, 90000);

  it('stream-redirects-to-range-capable-url', async () => {
    const publicId = await uploadAndWaitUntilReady();

    const redirect = await http().get(`/videos/${publicId}/stream`);
    expect(redirect.status).toBe(302);
    const location = redirect.headers.location;
    expect(location).toBeTruthy();

    const partial = await fetch(location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    expect((await partial.arrayBuffer()).byteLength).toBe(1024);
  }, 90000);

  it('download-redirects-with-attachment-disposition', async () => {
    const publicId = await uploadAndWaitUntilReady();

    const redirect = await http().get(`/videos/${publicId}/download`);
    expect(redirect.status).toBe(302);

    const file = await fetch(redirect.headers.location);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.mp4"',
    );
    expect((await file.arrayBuffer()).byteLength).toBe(video.length);
  }, 90000);

  // 2. Vídeos indisponíveis

  it('not-ready-video-cannot-stream-or-download', async () => {
    const channel = await context.dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: userId });
    const id = randomUUID();
    await context.dataSource.getRepository(Video).save({
      id,
      channel_id: channel.id,
      public_id: 'procVideo01',
      title: 'Still processing',
      status: VideoStatus.PROCESSING,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      file_size: 10,
      storage_key: `videos/${id}/original`,
    });

    const stream = await http().get('/videos/procVideo01/stream');
    expect(stream.status).toBe(409);
    expect(errorBody(stream).error).toBe('VIDEO_NOT_READY');

    const download = await http().get('/videos/procVideo01/download');
    expect(download.status).toBe(409);
    expect(errorBody(download).error).toBe('VIDEO_NOT_READY');

    const details = await http().get('/videos/procVideo01');
    expect(details.status).toBe(200);
    expect(detailsBody(details).status).toBe('processing');
    expect(detailsBody(details).thumbnailUrl).toBeNull();
  });

  it('unknown-public-id-returns-not-found', async () => {
    const details = await http().get('/videos/zzzzzzzzzzz');
    expect(details.status).toBe(404);
    expect(errorBody(details).error).toBe('VIDEO_NOT_FOUND');

    const stream = await http().get('/videos/zzzzzzzzzzz/stream');
    expect(stream.status).toBe(404);
    expect(errorBody(stream).error).toBe('VIDEO_NOT_FOUND');
  });
});

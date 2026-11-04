import request, { type Response } from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import type { UploadStateResponseDto } from '../src/videos/dto/upload-state-response.dto';
import type { VideoSummaryResponseDto } from '../src/videos/dto/video-summary-response.dto';
import type { VideoUploadResponseDto } from '../src/videos/dto/video-upload-response.dto';
import { findVideoJobs } from '../src/test/find-video-jobs';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { PROCESS_VIDEO_JOB } from '../src/video-processing/video-processing.constants';
import {
  bootstrapVideosApp,
  createUserWithToken,
  type VideosE2eContext,
} from './videos-e2e.helpers';

const PART_SIZE = 104857600;

const uploadBody = (res: Response) => res.body as VideoUploadResponseDto;
const stateBody = (res: Response) => res.body as UploadStateResponseDto;
const summaryBody = (res: Response) => res.body as VideoSummaryResponseDto;
const errorBody = (res: Response) => res.body as ApiErrorEnvelope;

describe('videos-upload', () => {
  let context: VideosE2eContext;
  let token: string;

  const validBody = {
    title: 'Meu vídeo',
    fileName: 'clip.mp4',
    fileSize: 262144000,
    contentType: 'video/mp4',
  };

  beforeAll(async () => {
    context = await bootstrapVideosApp();
    // The real video-worker container consumes this queue; pause it so the
    // jobs published by these tests remain observable.
    await context.queue.pause();
  });

  afterAll(async () => {
    await context.queue.obliterate({ force: true });
    await context.queue.resume();
    await cleanAllTables(context.dataSource);
    await context.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(context.dataSource);
    await context.queue.obliterate({ force: true });
    context.throttlerStorage.storage.clear();
    ({ token } = await createUserWithToken(context));
  });

  const http = () => request(context.app.getHttpServer());

  async function createDraft(body: Record<string, unknown>, auth = token) {
    return http()
      .post('/videos')
      .set('Authorization', `Bearer ${auth}`)
      .send(body);
  }

  async function putPart(url: string, bytes: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag') as string;
  }

  // 1. POST /videos — pré-cadastro do rascunho

  it('creates-draft-with-presigned-part-urls', async () => {
    const response = await createDraft(validBody);

    expect(response.status).toBe(201);
    const body = uploadBody(response);
    expect(body.status).toBe('draft');
    expect(body.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body.upload.partSize).toBe(PART_SIZE);
    expect(body.upload.partCount).toBe(3);
    expect(body.upload.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    for (const part of body.upload.parts) {
      expect(part.url).toMatch(/^http/);
    }

    const stored = await context.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: body.publicId });
    expect(stored.status).toBe(VideoStatus.DRAFT);
    expect(stored.upload_id).toBeTruthy();
    expect(stored.storage_key).toBe(`videos/${stored.id}/original`);
  });

  it('rejects-invalid-body', async () => {
    const tooLarge = await createDraft({ ...validBody, fileSize: 10737418241 });
    const notVideo = await createDraft({
      ...validBody,
      contentType: 'image/png',
    });
    const noTitle = await createDraft({
      fileName: validBody.fileName,
      fileSize: validBody.fileSize,
      contentType: validBody.contentType,
    });

    for (const response of [tooLarge, notVideo, noTitle]) {
      expect(response.status).toBe(400);
      expect(errorBody(response).error).toBe('VALIDATION_ERROR');
    }
  });

  it('requires-authentication', async () => {
    const response = await http().post('/videos').send(validBody);

    expect(response.status).toBe(401);
    expect(await context.dataSource.getRepository(Video).count()).toBe(0);
  });

  // 2. GET /videos/:publicId/upload — retomada

  it('resume-hidden-from-non-owner', async () => {
    const created = await createDraft(validBody);
    expect(created.status).toBe(201);
    const { publicId } = uploadBody(created);
    const { token: otherToken } = await createUserWithToken(context);

    const asOther = await http()
      .get(`/videos/${publicId}/upload`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(asOther.status).toBe(404);
    expect(errorBody(asOther).error).toBe('VIDEO_NOT_FOUND');

    const asOwner = await http()
      .get(`/videos/${publicId}/upload`)
      .set('Authorization', `Bearer ${token}`);
    expect(asOwner.status).toBe(200);
    const state = stateBody(asOwner);
    expect(state.status).toBe('draft');
    expect(state.uploadedParts).toEqual([]);
    expect(state.parts).toHaveLength(3);
  });

  // 3. POST /videos/:publicId/upload/complete — conclusão

  it('completes-upload-and-enqueues-processing', async () => {
    const file = Buffer.from('synthetic video payload for the e2e upload');
    const created = await createDraft({ ...validBody, fileSize: file.length });
    expect(created.status).toBe(201);
    const draft = uploadBody(created);
    expect(draft.upload.partCount).toBe(1);
    const publicId = draft.publicId;

    // The bytes go straight to the storage — never through the API.
    const etag = await putPart(draft.upload.parts[0].url, file);

    const state = stateBody(
      await http()
        .get(`/videos/${publicId}/upload`)
        .set('Authorization', `Bearer ${token}`),
    );
    expect(state.uploadedParts).toEqual([
      { partNumber: 1, etag, size: file.length },
    ]);
    expect(state.parts).toEqual([]);

    const completed = await http()
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag }] });
    expect(completed.status).toBe(202);
    expect(summaryBody(completed).status).toBe('processing');

    const stored = await context.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
    expect(stored.upload_id).toBeNull();
    const jobs = await findVideoJobs(context.queue, stored.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].data).toEqual({ videoId: stored.id });

    const again = await http()
      .post(`/videos/${publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag }] });
    expect(again.status).toBe(409);
    expect(errorBody(again).error).toBe('VIDEO_NOT_DRAFT');
  });

  it('rejects-invalid-parts', async () => {
    const file = Buffer.from('another synthetic payload');
    const draft = uploadBody(
      await createDraft({ ...validBody, fileSize: file.length }),
    );
    await putPart(draft.upload.parts[0].url, file);

    const response = await http()
      .post(`/videos/${draft.publicId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        parts: [{ partNumber: 1, etag: '"00000000000000000000000000000000"' }],
      });

    expect(response.status).toBe(422);
    expect(errorBody(response).error).toBe('UPLOAD_INCOMPLETE');
    const stored = await context.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: draft.publicId });
    expect(stored.status).toBe(VideoStatus.DRAFT);
  });
});

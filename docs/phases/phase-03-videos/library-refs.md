---
libs:
  bullmq:
    version: "^6.6.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-04T15:38:38-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-11-04T15:38:38-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-04T15:38:38-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-04T15:38:38-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T15:38:16-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this phase. Pulled via Context7 (`resolve-library-id` + `query-docs`) on 2026-11-04. Versions are the latest published on npm at fetch time and checked against the installed stack (`@nestjs/common@11.1.16`, `@nestjs/core@11.1.16`, Node 25): `@nestjs/bullmq@11.0.5` peers `@nestjs/common ^10 || ^11` and `bullmq ^3 || ^4 || ^5 || ^6`. Re-fetch when the underlying TD changes.

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7, High reputation, 4503 snippets; versions indexed up to v6.5.3 — npm latest is 6.6.1, same major). Maps to `phase-03-videos/TD-01` and the retry policy of `phase-03-videos/TD-07`.

### Retry with exponential backoff (TD-07: 3 attempts)

Retries happen after `2^(attempts-1) * delay` ms. Options are set per job when adding it:

```typescript
await queue.add(
  'process-video',
  { videoId },
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: 1000, // keep the last 1000 failed jobs for inspection
  },
);
```

### Auto-removal of finished jobs

`removeOnComplete` / `removeOnFail` accept `true`, a count, or `KeepJobs` (`{ age, count, limit }`, `age` in seconds). Removal is lazy — it runs when a new job completes or fails.

### v6 breaking changes relevant here (Context7 `/taskforcesh/bullmq` — changelog v6.0.0, fetched 2026-11-04 during SI-03.6)

- "ioredis is no longer installed as a direct dependency and is now an optional peer dependency. Redis users must install ioredis explicitly." → `ioredis@^5.11.1` added to `package.json` (same version bullmq uses in its own dev dependencies). Without it, `BullModule` fails at startup with "BullMQ could not load the optional 'ioredis' package".
- The `paused` job state no longer exists: jobs in a paused queue are reported as `waiting`.

### Notes for this phase

- A job is "failed for good" only after the last attempt; the worker must distinguish an intermediate failure from the final one (`job.attemptsMade >= job.opts.attempts`) before setting the video to `failed` (TD-07).
- The job payload carries only the video id — never file contents (TD-01 context).

## @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com` — `content/application/queues.md` (Context7, NestJS 11 branch indexed). Maps to `phase-03-videos/TD-01` and `phase-03-videos/TD-03`.

### Root connection via async factory (fits the inherited `registerAs` + `ConfigType` convention)

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    connection: {
      host: configService.get('QUEUE_HOST'),
      port: configService.get('QUEUE_PORT'),
    },
  }),
  inject: [ConfigService],
});
```

In this project the factory injects the namespaced config (`inject: [queueConfig.KEY]`) instead of `ConfigService`, per the inherited convention.

### Producer — inject the queue

```typescript
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

@Injectable()
export class AudioService {
  constructor(@InjectQueue('audio') private audioQueue: Queue) {}
}
```

The queue name must match `BullModule.registerQueue({ name })`.

### Consumer — `@Processor` + `WorkerHost`, worker events

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('audio')
export class AudioConsumer extends WorkerHost {
  async process(job: Job): Promise<void> { /* ... */ }

  @OnWorkerEvent('active')
  onActive(job: Job) { /* ... */ }
}
```

Worker events (`active`, `completed`, `failed`, …) must be declared inside the `@Processor()` class. The full list is the `WorkerListener` interface (v6). For TD-03 the consumer lives only in the worker module (loaded by the worker entrypoint), never in the API's module graph.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7, High reputation, 11189 snippets; versions indexed up to v3.1153.0 — npm latest 3.1161.0, same major). Maps to `phase-03-videos/TD-02`, `TD-06`, `TD-08`, `TD-09`.

### MinIO-compatible client

```typescript
const client = new S3Client({
  endpoint: 'http://minio:9000',  // TD-09: internal endpoint (service name)
  forcePathStyle: true,           // bucket in the path, required by MinIO
  region: 'us-east-1',
  credentials: { accessKeyId, secretAccessKey },
});
```

`forcePathStyle` is the v3 name of v2's `s3ForcePathStyle`.

### Multipart commands used by TD-02

`CreateMultipartUpload` → (client PUTs parts to presigned `UploadPart` URLs) → `ListParts` (resume, TD-02 revision) → `CompleteMultipartUpload` with `{ Parts: [{ ETag, PartNumber }] }` → `HeadObject` to re-check the final size.

### Checksum default (important for MinIO + presigned URLs)

`DEFAULT_REQUEST_CHECKSUM_CALCULATION = WHEN_SUPPORTED`: the SDK adds CRC32 checksum headers (`x-amz-sdk-checksum-algorithm`, `x-amz-checksum-crc32`) to operations that model a checksum member (e.g. `PutObject`, `UploadPart`). For presigned URLs that a browser/client will use, configure the client with `requestChecksumCalculation: 'WHEN_REQUIRED'` (and `responseChecksumValidation: 'WHEN_REQUIRED'`) so no checksum parameter is baked into the signature that the client cannot reproduce.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` — `packages/s3-request-presigner/README.md`. Maps to `phase-03-videos/TD-02`, `TD-06`, `TD-09`.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(client, new GetObjectCommand(params), { expiresIn: 3600 });
```

- `expiresIn` defaults to 900 s; TD-06 uses 3600 s.
- The client passed to `getSignedUrl` defines the host in the URL — TD-09 signs with a second client configured with the **public** endpoint (`http://localhost:9000`).
- Download (TD-06): `GetObjectCommand({ ..., ResponseContentDisposition: 'attachment; filename="..."' })`. Response-header overrides (`response-content-disposition`) **must be signed** — they only work through a presigned URL, never on an anonymous request.
- `unhoistableHeaders` forces chosen `x-amz-*` headers to be signed and required in the client request (not used in this phase).

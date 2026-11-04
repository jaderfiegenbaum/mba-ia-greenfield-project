---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-04
scope_description: "Backend foundation for video upload and processing: background queue technology, 10GB direct-to-storage upload protocol, video worker runtime and FFmpeg tooling, unique public video id, streaming/download delivery, status lifecycle with failure handling, object storage layout and distribution, and presigned-URL endpoint reachability."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the `videos` module (pre-registration, upload handshake, streaming/download endpoints), the new infrastructure in `compose.yaml` (object storage, queue broker, video worker) and the video worker process itself.
- `next-frontend/` — no open decision in this document: the video UI (upload screen, player) is explicitly out of scope for this phase (challenge statement: "a interface de vídeo não faz parte do escopo desta fase"). Cross-layer TDs below (TD-02, TD-06) fix the HTTP contract the frontend will consume in a later phase.

---

## TD-01: Background Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) leaves the Message Queue container as `TBD`. The API must publish a "process video" job after an upload completes and a separate worker must consume it. Jobs are long-running (ffprobe + ffmpeg on multi-GB files), need retries and must not be lost if the worker restarts. Installed stack: NestJS 11.1, Node 25, PostgreSQL 17 (no Redis today).

**Options:**

### Option A: BullMQ + Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue with an official NestJS integration (`BullModule.forRoot/registerQueue`, `@Processor`/`WorkerHost`). Jobs carry only references (video id), retries/backoff, concurrency and stalled-job detection are built in.
- **Pros:** Official Nest package (`@nestjs/bullmq@11.0.5` peers `@nestjs/common ^11`, `bullmq ^5 || ^6`). Retry with exponential backoff, `attempts`, `removeOnComplete`, stalled-job recovery out of the box. Redis image is small and trivial to run in Compose. De-facto default for NestJS background jobs.
- **Cons:** Adds Redis as a new infrastructure dependency (persistence must be configured — AOF — to avoid losing jobs on restart). Redis is single-threaded; very high throughput would need clustering (not a concern at this scale).

### Option B: pg-boss (PostgreSQL-backed queue)
- Job queue that stores jobs in a PostgreSQL schema using `SKIP LOCKED`. Reuses the existing `db` service.
- **Pros:** No new infrastructure — PostgreSQL is already in the stack. Transactional enqueue is possible (job insert in the same transaction as the video status update). Retries and expiration supported.
- **Cons:** No official NestJS module (manual provider wiring). Polling-based delivery adds latency. Puts queue load on the primary database that also serves the API. Diverges from the architecture diagram, which models the queue as its own container.

### Option C: RabbitMQ (`amqplib` / `@golevelup/nestjs-rabbitmq`)
- General-purpose AMQP broker; API publishes a message, worker consumes with manual ack.
- **Pros:** Mature broker, language-agnostic consumers (a non-Node FFmpeg worker could consume). Rich routing (exchanges, DLQ).
- **Cons:** Heavier container and operational surface. Retry/backoff and delayed retries must be built from DLX + TTL patterns. NestJS microservice transport is message-oriented, not job-oriented (no job state, progress or attempts tracking).

**Recommendation:** **Option A (BullMQ + Redis)** — It is the only option with an official NestJS 11 integration and job semantics (attempts, backoff, stalled detection) that TD-07's failure policy needs without extra code; Redis matches the diagram's separate queue container and costs one small Compose service.

**Decision:** A (BullMQ + Redis)

**Libraries:** bullmq, @nestjs/bullmq

---

## TD-02: Large File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB file must not flow through the NestJS process (memory, event-loop and request timeouts). `docs/project-plan.md` § Pontos de Atenção also requires the upload to "retomar em caso de falha de conexão". The protocol defines the handshake both the backend (now) and the frontend (later phase) must follow, hence Cross-layer. S3 limits: single `PutObject` max 5GB; multipart up to 10,000 parts of 5MiB–5GiB each.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (direct to storage)
- `POST /videos` creates the video as draft and calls `CreateMultipartUpload`; the API returns presigned `UploadPart` URLs; the client PUTs each part straight to the object storage and finally calls `POST /videos/:id/upload/complete` with the part ETags (`CompleteMultipartUpload`).
- **Pros:** Zero video bytes through the API. Resumable per part (retry only failed parts; `ListParts` recovers state). Parallel part uploads. Same protocol works on MinIO and AWS S3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`).
- **Cons:** Multi-step handshake on the client. Presigned URLs must be reachable from the client (see TD-09). Abandoned multipart uploads keep parts in storage until aborted (bucket lifecycle rule mitigates).

### Option B: tus resumable protocol through the API (`@tus/server` + S3 store)
- The API hosts a tus endpoint; the client sends chunks to the API, which relays them to S3 multipart.
- **Pros:** Standard resumable protocol with mature clients (`tus-js-client`, Uppy). Server-side control of every chunk.
- **Cons:** Every byte of the 10GB still crosses the API process — exactly what the challenge forbids ("passar o arquivo pela API"). Needs a separate HTTP handler outside Nest's controller model. Extra dependency.

### Option C: Single presigned `PutObject` URL
- API returns one presigned PUT; client uploads the whole file in one request.
- **Pros:** Simplest handshake (one URL).
- **Cons:** Hard 5GB S3 limit — cannot satisfy the 10GB requirement. No resume: any network failure restarts the whole upload.

**Recommendation:** **Option A (presigned multipart)** — It is the only option that both keeps bytes out of the API and satisfies 10GB + resume; part size policy: fixed 100 MiB parts (10GB → ~100 parts, well inside the 10,000-part limit), declared size validated `≤ 10 GiB` at initiation and re-checked with `HeadObject` after completion.

**Decision:** A (Presigned S3 multipart upload, direct to storage)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-11-04 — Upload-start payload fixed: client sends `title` (required), `fileName`, `fileSize` (≤ 10 GiB) and `contentType` (`video/*` only), all validated by the DTO. Rationale: resolves AMB-2 (phase-03-videos validation) — pre-registration fields were unspecified.
- 2026-11-04 — Resume contract added: `GET /videos/:id/upload` (owner-only, status `draft`) returns parts already uploaded (`ListParts`) plus fresh presigned URLs for the missing parts. Rationale: resolves AMB-3 — `docs/project-plan.md` § Pontos de Atenção requires resuming after connection failure.

---

## TD-03: Video Worker Runtime and Placement

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The diagram defines a separate "Video Worker (FFmpeg)" container that consumes the queue and updates DB and storage. Where its code lives and how it boots affects `compose.yaml`, Dockerfiles, test layout and how entities/config are shared with the API.

**Options:**

### Option A: Same `nestjs-project/` codebase, separate entrypoint and Compose service
- A second bootstrap (`src/worker.ts` → `NestFactory.createApplicationContext(WorkerModule)`) runs the queue processor; Compose adds a `video-worker` service built from a Dockerfile that includes FFmpeg, mounting the same source.
- **Pros:** Reuses entities, TypeORM config, Joi validation and storage service without a shared package. Single test suite/lint/tsc gate (Definition of Done stays one command set). Separate process and container — API never runs FFmpeg.
- **Cons:** Worker image carries API dependencies it does not use. Module boundaries must be kept explicit (worker module must not import HTTP controllers).

### Option B: Separate subproject (`video-worker/`)
- Independent Node project with its own `package.json`, Dockerfile and tests.
- **Pros:** Hard isolation; worker can evolve or be rewritten in another language.
- **Cons:** Duplicates entity/config/storage code or requires a shared package (monorepo tooling not in place). Second test/lint/tsc pipeline to keep green.

### Option C: Processor inside the API process
- `@Processor` registered in the API app itself.
- **Pros:** Simplest — no new service.
- **Cons:** FFmpeg CPU load competes with HTTP handling ("sem travar o sistema" violated under load). Contradicts the diagram's separate worker container.

**Recommendation:** **Option A** — Separate process/container as the diagram requires, while reusing the existing module, config and entity code inside one subproject so the Definition of Done remains a single suite.

**Decision:** A (Same codebase, separate entrypoint and Compose service)

---

## TD-04: Media Probing and Thumbnail Tooling

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration and metadata (ffprobe) and grab one frame as thumbnail (ffmpeg). The npm package `fluent-ffmpeg` (2.1.3) is marked deprecated on npm ("Package no longer supported"). Input files can be 10GB, so how the worker reads the source matters as much as the wrapper.

**Options:**

### Option A: System `ffmpeg`/`ffprobe` binaries invoked via `child_process.spawn`, reading the object through a presigned GET URL
- Worker image installs FFmpeg from the distro; a small adapter spawns `ffprobe -print_format json -show_format -show_streams <url>` and `ffmpeg -ss <t> -i <url> -frames:v 1 ...`, both reading over HTTP with range requests.
- **Pros:** No deprecated wrapper; JSON output is typed by our own interface. FFmpeg reads only the bytes it needs (container header + one frame) — no 10GB local copy. Binary version pinned by the image.
- **Cons:** Own argument building and error parsing (exit codes/stderr). Needs the worker to reach storage via an internal endpoint (TD-09).

### Option B: `fluent-ffmpeg` wrapper
- Fluent API over the same binaries (`ffprobe()`, `screenshots()`).
- **Pros:** Familiar API, many examples.
- **Cons:** Deprecated and unmaintained on npm; `@types` lag; adds a dependency the project would have to replace later.

### Option C: npm-shipped static binaries (`ffmpeg-static` / `@ffprobe-installer/ffprobe`) + download the object to a temp file
- Binaries come from npm; the worker downloads the whole object to local disk and processes it.
- **Pros:** No apt install in the image.
- **Cons:** Copies up to 10GB to the container disk per job (I/O, disk space, time). Binary provenance tied to npm package maintainers.

**Recommendation:** **Option A** — Avoids a deprecated dependency and the 10GB local copy; thumbnail policy: frame at 10% of the duration (capped to the last second for very short clips), JPEG scaled to 1280 px width.

**Decision:** A (System ffmpeg/ffprobe via spawn, reading a presigned GET URL)

---

## TD-05: Unique Public Video Identifier (URL)

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** `docs/project-plan.md` § Pontos de Atenção asks for "uma URL curta e única que nunca conflite com outro vídeo". Primary keys in the project are UUIDs (users, channels). The public id appears in every video URL (`/videos/:publicId/...`). The backend is CommonJS (TypeScript `module: commonjs`), which matters for ESM-only libraries such as `nanoid@5+`.

**Options:**

### Option A: Random 11-char base64url id generated with `node:crypto`, unique index + retry on collision
- `randomBytes(8)` → 11 base64url chars (64 bits, YouTube-like). A unique index on `videos.public_id` guarantees no conflict; on `23505` the service regenerates (same pattern as channel nickname collision handling, phase-02 TD-10).
- **Pros:** Short, non-enumerable, no dependency, no ESM interop issue. DB constraint is the source of truth for uniqueness.
- **Cons:** Needs collision-retry code (rare at 64 bits).

### Option B: Use the UUID primary key in the URL
- `/videos/3f1c...-...` (36 chars).
- **Pros:** No extra column or generation logic; globally unique by construction.
- **Cons:** Not "curta" as the plan requires; exposes the internal PK.

### Option C: Encode a sequential id (Sqids/Hashids)
- Bigint sequence encoded to a short alphabet string.
- **Pros:** Short and collision-free by construction.
- **Cons:** Reversible/enumerable (reveals volume and ordering); requires a sequence column plus a dependency.

**Recommendation:** **Option A** — Meets "curta e única" with a DB-enforced guarantee, reuses the collision-retry pattern already in the codebase and adds no dependency.

**Decision:** A (11-char base64url id via node:crypto + unique index + retry)

---

## TD-06: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, which requires HTTP range requests (`206 Partial Content`). The diagram models "Frontend → Object Storage: Streams", i.e. bytes served by storage, not by the API. Download must deliver the original file with `Content-Disposition: attachment`. Both behaviours define what the frontend player/download button will call later.

**Options:**

### Option A: API authorizes and redirects (302) to a short-lived presigned GET URL
- `GET /videos/:publicId/stream` → 302 to a presigned GET (inline); `GET /videos/:publicId/download` → 302 to a presigned GET with `ResponseContentDisposition=attachment`. The object storage answers `Range` requests with `206` natively.
- **Pros:** Video bytes never pass through the API (consistent with the diagram and with TD-02). Range/seek handled by S3/MinIO. Same mechanism for streaming and download.
- **Cons:** URL is valid for its TTL (shareable until expiry). Requires presigned URLs reachable by the client (TD-09).

### Option B: API proxies the object with Range support
- The API parses `Range`, calls `GetObject` with the same range and pipes the body with `206`, `Content-Range`, `Accept-Ranges`.
- **Pros:** Storage never exposed to clients; fine-grained per-request authorization.
- **Cons:** All playback bandwidth flows through Node processes — contradicts the diagram and scales poorly. More code (range parsing, header mapping, aborted-connection handling).

### Option C: HLS adaptive streaming (transcode to segments)
- Worker transcodes to HLS renditions; player fetches a `.m3u8` and segments.
- **Pros:** Adaptive bitrate, industry-standard for large platforms.
- **Cons:** Heavy transcoding per upload (time, CPU, storage ×N renditions) — far beyond the phase capability ("sem necessidade de download completo" is already met by range requests). Not required by any phase bullet.

**Recommendation:** **Option A** — Matches the diagram (frontend streams from storage) and keeps the API out of the data path; presigned TTL of 1 hour for stream and download URLs; only videos in status `ready` can be streamed/downloaded.

**Decision:** A (302 redirect to short-lived presigned GET; storage serves 206)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-11-04 — Access policy fixed: stream and download endpoints are public (`@Public()`, anonymous allowed) for videos in status `ready`; visibility rules (public/unlisted) are deferred to Phase 04. Rationale: resolves AMB-1 — `docs/project-plan.md` § Visão Geral (anonymous users watch freely).

---

## TD-07: Video Status Lifecycle and Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The challenge requires the lifecycle `rascunho → processando → pronto/erro` reflected in the database. The worker may fail transiently (storage hiccup, worker restart) or permanently (corrupted/non-video file). Depends on TD-01 (retry capabilities of the queue).

**Options:**

### Option A: `draft → processing → ready | failed`, queue retries with backoff, `failed` only after the last attempt
- API sets `processing` and enqueues on upload completion; the worker is idempotent (re-running overwrites thumbnail/metadata); job `attempts: 3` with exponential backoff; on final failure the worker sets `failed` and stores a short `processing_error`.
- **Pros:** Transient errors self-heal; permanent errors become visible in the DB. Idempotent worker makes retries safe.
- **Cons:** A permanently broken file takes 3 attempts before `failed`.

### Option B: Fail fast — no retries
- Any processing error sets `failed` immediately.
- **Pros:** Simplest; immediate feedback.
- **Cons:** Transient infrastructure errors permanently fail videos that were fine.

### Option C: Retries + manual reprocess endpoint
- Option A plus `POST /videos/:id/reprocess` for the owner.
- **Pros:** Recovery path for videos stuck in `failed`.
- **Cons:** New endpoint and authorization rules not required by any phase bullet (extrapolation for this phase).

**Recommendation:** **Option A** — Satisfies the required lifecycle and failure visibility using BullMQ's native attempts/backoff (TD-01), without endpoints the phase does not ask for.

**Decision:** A (draft → processing → ready | failed; 3 attempts with exponential backoff)

---

## TD-08: Object Storage Layout and Bucket Provisioning

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage technology is fixed (S3-compatible; MinIO locally). The layout of buckets/keys is shared by the API (initiates uploads, signs URLs), the worker (reads source, writes thumbnail), `compose.yaml` and the env schema — a cross-component contract.

**Options:**

### Option A: One private bucket, per-video key prefix, created by a one-shot `mc` init service in Compose
- Bucket `streamtube-videos` (private); keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`; an init container runs `mc mb --ignore-existing` and sets an abort-incomplete-multipart lifecycle rule.
- **Pros:** Everything about a video lives under one prefix (easy deletion in later phases). Provisioning is declarative in Compose; app code assumes the bucket exists. All access via presigned URLs — no public bucket policy.
- **Cons:** Extra one-shot service in Compose.

### Option B: Two buckets (`videos`, `thumbnails`), thumbnails public-read
- **Pros:** Thumbnails served without signing (cacheable URLs).
- **Cons:** Two buckets to provision and configure; public bucket policy diverges between MinIO and S3 setups; splits a video's assets.

### Option C: One bucket, created by the API at boot (`HeadBucket`/`CreateBucket`)
- **Pros:** No init container.
- **Cons:** API needs bucket-admin permissions in production; race between API and worker on startup; provisioning mixed into app code.

**Recommendation:** **Option A** — Single private bucket with per-video prefixes keeps the contract small, and provisioning stays in infrastructure (Compose), not in application code.

**Decision:** A (One private bucket, per-video prefix, mc init service)

---

## TD-09: S3 Endpoint Reachability for Presigned URLs (internal vs public)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Inside Compose, services reach storage at `http://minio:9000` (service name — CLAUDE.md Docker Networking rule). Presigned URLs, however, are used by clients outside the Docker network, and SigV4 signs the `Host` header, so a URL signed for `minio:9000` cannot simply be rewritten to `localhost:9000`. Depends on TD-02 and TD-06.

**Options:**

### Option A: Two endpoints — internal for server-side calls, public for signing
- Env `S3_ENDPOINT=http://minio:9000` (API/worker operations) and `S3_PUBLIC_ENDPOINT=http://localhost:9000` (only for presigning); two `S3Client` instances in the storage service.
- **Pros:** Respects the "service name as host" rule for all server traffic; clients get URLs that resolve from the host. Maps cleanly to production (internal VPC endpoint vs public CDN/S3 domain).
- **Cons:** Two clients and one extra env var to keep consistent.

### Option B: Single endpoint plus a host alias (`/etc/hosts`: `minio → 127.0.0.1`)
- **Pros:** One client, one URL.
- **Cons:** Requires manual change on every developer machine; breaks "runs entirely in Docker".

### Option C: Proxy storage under the API's origin (e.g. `/storage/*` reverse proxy)
- **Pros:** Single public origin.
- **Cons:** Brings video bytes back through an HTTP layer in front of the API; needs an extra reverse-proxy service.

**Recommendation:** **Option A** — The only option that keeps server traffic on the Compose network (`minio`) while giving clients resolvable presigned URLs, with no manual host setup.

**Decision:** A (Internal + public S3 endpoints)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-10: Local Object Storage Distribution (MinIO image)

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The challenge fixes MinIO (S3 API) for local development. Verified on 2026-11-04 from this environment: `docker pull minio/minio` fails ("repository does not exist or may require 'docker login'") and `quay.io/minio/minio` returns "unauthorized"; upstream MinIO Community Edition stopped publishing images in late 2025 and the repository was archived in 2026. `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (AGPLv3 community fork) pulls and reports `minio version RELEASE.2026-08-04T00-00-00Z`.

**Options:**

### Option A: Community fork image `pgsty/minio`, pinned by release tag (plus `pgsty/mc` for the init job)
- **Pros:** Pullable today, same S3 API and `mc` tooling, actively published. Pinning the release tag keeps builds reproducible.
- **Cons:** Third-party fork (trust and longevity risk); AGPL (acceptable for a local dev dependency, not shipped).

### Option B: Build MinIO from the archived upstream source in a local Dockerfile
- **Pros:** Upstream code, no third-party image.
- **Cons:** Slow multi-stage Go build for every developer; frozen code with no security fixes.

### Option C: A different S3-compatible server (e.g. Garage, SeaweedFS)
- **Pros:** Actively maintained alternatives.
- **Cons:** Contradicts the challenge statement ("na prática você roda MinIO localmente"); S3 compatibility differences (presigned multipart, checksums) would need re-validation.

**Recommendation:** **Option A** — Keeps MinIO as the challenge requires with a reproducible, pullable image; production would point to AWS S3 through the same env vars (TD-09), so the fork is only a dev/test dependency.

**Decision:** A (pgsty/minio pinned by release tag)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Queue Technology | A (BullMQ + Redis) | A (BullMQ + Redis) |
| TD-02 | Cross-layer | Large File Upload Protocol (10GB) | A (presigned S3 multipart) | A (Presigned S3 multipart upload, direct to storage) |
| TD-03 | Repo-wide | Video Worker Runtime and Placement | A (same codebase, separate entrypoint/service) | A (Same codebase, separate entrypoint and Compose service) |
| TD-04 | Backend | Media Probing and Thumbnail Tooling | A (spawn system ffmpeg/ffprobe over presigned URL) | A (System ffmpeg/ffprobe via spawn, reading a presigned GET URL) |
| TD-05 | Backend | Unique Public Video Identifier | A (11-char base64url + unique index + retry) | A (11-char base64url id via node:crypto + unique index + retry) |
| TD-06 | Cross-layer | Streaming and Download Delivery | A (302 to presigned GET; storage serves 206) | A (302 redirect to short-lived presigned GET; storage serves 206) |
| TD-07 | Backend | Status Lifecycle and Failure Policy | A (draft→processing→ready/failed, 3 attempts) | A (draft → processing → ready | failed; 3 attempts with exponential backoff) |
| TD-08 | Repo-wide | Object Storage Layout and Provisioning | A (one private bucket, per-video prefix, mc init) | A (One private bucket, per-video prefix, mc init service) |
| TD-09 | Cross-layer | S3 Endpoint Reachability for Presigned URLs | A (internal + public endpoints) | A (Internal + public S3 endpoints) |
| TD-10 | Repo-wide | Local Object Storage Distribution | A (pgsty/minio pinned) | A (pgsty/minio pinned by release tag) |

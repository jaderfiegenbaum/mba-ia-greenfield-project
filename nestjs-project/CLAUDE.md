# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl -f http://localhost:9000/minio/health/live` — expect HTTP 200; `docker compose ps -a minio-init` must show `Exited (0)` (bucket provisioned)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, SMTP `1025`, UI `8025`
- `minio` — S3-compatible object storage (`pgsty/minio`, pinned release), API `9000`, console `9001`, credentials `S3_ACCESS_KEY` / `S3_SECRET_KEY`
- `minio-init` — one-shot job that creates the private bucket `S3_BUCKET` (`streamtube-videos`); exits with code 0
- `redis` — Redis 8 (AOF on) for the BullMQ queue, port `6379`
- `video-worker` — video processing worker: same image (`Dockerfile.dev`, which includes `ffmpeg`/`ffprobe`) and source as the API, runs `npm run start:worker:dev`; starts with the stack and restarts on failure. Needs `node_modules` installed once (`docker compose exec nestjs-api npm install`).

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npm run build:worker                     # Compile the video worker to dist-worker/
npm run start:worker                     # Run the compiled worker (node dist-worker/worker)
npm run start:worker:dev                 # Worker in watch mode (what the video-worker service runs)
npm run openapi:export                   # Regenerate openapi.json

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Integration and e2e suites of the videos feature use the **real** MinIO, Redis and FFmpeg of the Compose stack (no mocks): `src/test/storage-test-config.ts` / `src/test/videos-test-module.ts` (integration) and `test/videos-e2e.helpers.ts` (e2e). Because tests run inside the Compose network, they sign client URLs with `S3_ENDPOINT` instead of `S3_PUBLIC_ENDPOINT`. Test videos are generated on the fly with ffmpeg (`src/test/synthetic-video.ts`). `test/videos-playback.e2e-spec.ts` waits for the running `video-worker` container to process the upload, so the full stack must be up.

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints: `src/main.ts` (HTTP API, `AppModule`) and `src/worker.ts` (video worker, `WorkerModule` — application context without HTTP)

## Videos

Upload, processing and playback of videos (Phase 03). Plan and decisions: `docs/phases/phase-03-videos/`, `docs/decisions/technical-decisions-phase-03-videos.md`.

### Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| `StorageModule` | `src/storage/` | `StorageService` — the only code that talks to S3/MinIO: multipart upload, `ListParts`, `HeadObject`, `PutObject`, presigned URLs. Two clients: internal (`S3_ENDPOINT`) for server calls, public (`S3_PUBLIC_ENDPOINT`) only for signing client URLs. |
| `QueueModule` | `src/queue/` | BullMQ connection to Redis (`queueConfig`) and registration of the `video-processing` queue. Shared by API (producer) and worker (consumer). |
| `VideosModule` | `src/videos/` | `VideosController` + `VideosService`: draft pre-registration, upload resume/completion, job publishing, public details/stream/download. Entity `Video` (`src/videos/entities/video.entity.ts`). |
| `VideoProcessingModule` | `src/video-processing/` | Worker side: `VideoProcessingProcessor` (BullMQ consumer), `VideoProcessingService` (status transitions) and `MediaProbeService` (spawns `ffprobe`/`ffmpeg` over a presigned URL). Loaded only by `WorkerModule` (`src/worker.module.ts`). |

Queue contract (`src/video-processing/video-processing.constants.ts`): queue `video-processing`, job `process-video`, payload `{ videoId }`, `attempts: 3`, exponential backoff (1 s). On the final failed attempt the video becomes `failed` with `processing_error`.

Storage layout (`src/videos/videos.constants.ts`): bucket `S3_BUCKET`, keys `videos/{id}/original` and `videos/{id}/thumbnail.jpg`. Fixed part size 100 MiB; max file size 10 GiB; presigned URLs valid for 3600 s.

### Endpoints

| Method & route | Auth | Response |
|----------------|------|----------|
| `POST /videos` | JWT | `201` draft + presigned part URLs (`title`, `fileName`, `fileSize` ≤ 10 GiB, `contentType` `video/*`) |
| `GET /videos/:publicId/upload` | JWT, owner | `200` uploaded parts + fresh URLs for missing parts (resume) |
| `POST /videos/:publicId/upload/complete` | JWT, owner | `202` status `processing`; publishes `process-video` |
| `GET /videos/:publicId` | Public | `200` details (status, duration, metadata, thumbnail URL when `ready`) |
| `GET /videos/:publicId/stream` | Public | `302` to presigned URL (storage serves `Range` → `206`) |
| `GET /videos/:publicId/download` | Public | `302` to presigned URL with `Content-Disposition: attachment` |

Non-owners get `404 VIDEO_NOT_FOUND`. Domain errors live in `src/videos/exceptions/video.exceptions.ts`: `CHANNEL_NOT_FOUND`, `VIDEO_NOT_FOUND`, `VIDEO_NOT_DRAFT`, `VIDEO_NOT_READY`, `UPLOAD_INCOMPLETE`, `UPLOAD_SIZE_MISMATCH`.

### Environment variables

`S3_ENDPOINT` (in-network, `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (host-facing, `http://localhost:9000` — signing only), `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST` (`redis`), `REDIS_PORT` (default `6379`). Validated by Joi in `src/config/env.validation.ts`; exposed via `src/config/storage.config.ts` and `src/config/queue.config.ts`. `bullmq` v6 requires `ioredis` installed explicitly (it is in `package.json`).

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

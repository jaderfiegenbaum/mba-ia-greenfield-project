---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-04T16:23:51-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-04T16:02:22-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T15:38:16-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-23T16:08:51-03:00"
  docs/project-plan.md: "2026-09-23T16:08:51-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no `nestjs-project/` o armazenamento de arquivos (vídeos e thumbnails), o processamento em segundo plano via fila e worker, o upload de vídeos de até 10GB sem impacto na performance com pré-cadastro automático como rascunho, o processamento automático (duração, metadados e thumbnail), a URL única por vídeo, a reprodução via streaming e o download — com upload de até 10GB funcional, processamento automático, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Infra: object storage, broker e FFmpeg no Compose

**Description:** Sobe a infraestrutura nova da fase no `compose.yaml` (MinIO, provisionamento do bucket e Redis) e adiciona FFmpeg à imagem de desenvolvimento, base para storage, fila e worker.

**Technical actions:**

1. Adicionar serviço `minio` em `nestjs-project/compose.yaml` com a imagem `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, portas `9000` (API S3) e `9001` (console), volume nomeado e healthcheck (per `phase-03-videos/TD-10`)
2. Adicionar serviço one-shot `minio-init` (imagem `pgsty/mc`) que cria o bucket privado `streamtube-videos` com `mc mb --ignore-existing` e aplica regra de lifecycle que aborta multipart uploads incompletos; `nestjs-api` passa a depender dele com `service_completed_successfully` (per `phase-03-videos/TD-08`)
3. Adicionar serviço `redis` (imagem `redis:8.8`) com `appendonly yes`, volume nomeado e healthcheck `redis-cli ping` (per `phase-03-videos/TD-01`)
4. Instalar `ffmpeg` (pacote Debian, provê `ffmpeg` e `ffprobe`) no `nestjs-project/Dockerfile.dev`, imagem compartilhada pela API e pelo worker (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
5. Acrescentar ao `nestjs-project/.env.example` as chaves `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET=streamtube-videos`, `REDIS_HOST=redis`, `REDIS_PORT=6379` — sempre nomes de serviço do Compose como host (per `phase-03-videos/TD-09`)

**Tests:** _(empty — Infra; smoke-gated by the Compose health ACs below)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `minio`, `redis` e `db` com status `healthy` e `minio-init` com exit code `0`
- `docker compose exec redis redis-cli ping` retorna `PONG`
- O bucket `streamtube-videos` existe e não permite leitura anônima (`curl http://localhost:9000/streamtube-videos/x` retorna `403`)
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` saem com código `0`

---

### SI-03.2 — Infra: dependências e configuração de storage e fila

**Description:** Instala as bibliotecas decididas e cria os namespaces de configuração `storage` e `queue` validados por Joi, seguindo as convenções herdadas da Fase 01.

**Technical actions:**

1. Instalar `bullmq@^6.6.1`, `@nestjs/bullmq@^11.0.5`, `@aws-sdk/client-s3@^3.1161.0` e `@aws-sdk/s3-request-presigner@^3.1161.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`; versões em `library-refs.md`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com `endpoint`, `publicEndpoint`, `region`, `accessKey`, `secretKey`, `bucket` (per `phase-03-videos/TD-09`; convenção herdada `phase-01-configuracao-base/TD-03`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` com `host` e `port` do Redis (per `phase-03-videos/TD-01`)
4. Estender o schema Joi em `src/config/env.validation.ts` com `S3_ENDPOINT` (uri), `S3_PUBLIC_ENDPOINT` (uri), `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST` (obrigatórios) e `REDIS_PORT` (port, default 6379) (per `phase-01-configuracao-base/TD-02`)
5. Registrar `storageConfig` e `queueConfig` no `ConfigModule.forRoot({ load: [...] })` do `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Env schema (`env.validation.ts`) | Integration: rejeita ausência de `S3_*`/`REDIS_HOST`, aceita conjunto válido, aplica default de `REDIS_PORT` | `src/config/env.validation.integration-spec.ts` |
| `storageConfig` / `queueConfig` | Unit: mapeiam env → objeto tipado | `src/config/storage-queue.config.spec.ts` |

**Dependencies:** SI-03.1 — as chaves de env e os serviços `minio`/`redis` precisam existir

**Acceptance criteria:**

- A aplicação não inicia quando `S3_ENDPOINT` ou `REDIS_HOST` estão ausentes, listando as chaves faltantes no erro de validação
- Com o `.env` derivado do `.env.example`, `storageConfig()` expõe `endpoint = http://minio:9000` e `publicEndpoint = http://localhost:9000`
- `REDIS_PORT` ausente resolve para `6379`

---

### SI-03.3 — Serviço de object storage (StorageModule)

**Description:** Encapsula todo acesso ao S3/MinIO num `StorageService` com dois clientes (interno para operações do servidor, público para assinar URLs), único ponto do sistema que fala com o storage.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` exportando `StorageService`; injeta `storageConfig.KEY` (convenção herdada `phase-01-configuracao-base/TD-03`)
2. Criar `src/storage/storage.service.ts` com dois `S3Client` (`forcePathStyle: true`, `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`): `internalClient` em `S3_ENDPOINT` e `publicClient` em `S3_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-09`; `library-refs.md` → @aws-sdk/client-s3)
3. Implementar multipart: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, expiresIn)` (cliente público), `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)`, `headObjectSize(key)` (per `phase-03-videos/TD-02`)
4. Implementar leitura/escrita: `presignGet(key, { expiresIn, downloadFileName? })` com cliente público e `ResponseContentDisposition` quando `downloadFileName` é informado; `presignInternalGet(key, expiresIn)` com cliente interno (para o worker); `putObject(key, body, contentType)` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-04`)
5. Traduzir erros do S3 em exceções de storage tipadas (`StorageInvalidPartsError` para `InvalidPart`/`InvalidPartOrder`/`NoSuchUpload`), sem vazar tipos do SDK para os chamadores

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: multipart real no MinIO (create → upload de parte via URL pré-assinada → listParts → complete → head), putObject + presignInternalGet, erro tipado para ETag inválido | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` | Unit: URLs pré-assinadas usam o host do endpoint público; download inclui `response-content-disposition=attachment` | `src/storage/storage.service.spec.ts` |
| `StorageModule` | Unit: compilação do módulo com config de teste | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2 — `storageConfig` e o SDK instalados

**Acceptance criteria:**

- Um objeto enviado em partes via URLs pré-assinadas e concluído com `completeMultipartUpload` fica disponível com o tamanho exato da soma das partes
- `listParts` após o envio de uma parte retorna essa parte com `partNumber` e `etag`
- `completeMultipartUpload` com ETag inválido lança `StorageInvalidPartsError`
- URLs geradas por `presignGet`/`presignUploadPart` têm host igual ao de `S3_PUBLIC_ENDPOINT`; `presignInternalGet` usa o host de `S3_ENDPOINT`

---

### SI-03.4 — Entidade Video e migration CreateVideos

**Description:** Cria a tabela `videos` ligada ao canal, com status, chaves de storage, duração, metadados e o identificador público único.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos do `### Data Model → Video` (enum `VideoStatus` = `draft | processing | ready | failed`; `file_size` bigint com transformer para `number`; `metadata` jsonb tipado) e relação `ManyToOne` com `Channel` via `channel_id` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
2. Adicionar `OneToMany` inverso `videos` em `src/channels/entities/channel.entity.ts`
3. Criar `src/database/migrations/<timestamp>-CreateVideos.ts` — enum `videos_status_enum`, tabela, FK `channel_id → channels(id) ON DELETE CASCADE`, índice único em `public_id` e índice em `channel_id`; `down` remove tabela e enum
4. Incluir a nova migration e a entidade no teste de migrations existente (`src/database/migrations.integration-spec.ts`) e no `createTestDataSource` dos testes de integração que dependem do schema completo

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: default `status = draft`, unique `public_id`, FK com cascade ao remover o canal, enum rejeita valor inválido, `file_size` > 2^31 persiste e volta como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration `CreateVideos` | Integration: `up` cria a tabela `videos`; `down` remove tabela e enum | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none _(independe de storage/fila; usa apenas o banco da Fase 01)_

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com o enum `videos_status_enum`
- Inserir um vídeo sem `status` persiste `draft`
- Inserir dois vídeos com o mesmo `public_id` falha por violação de unicidade
- Remover um canal remove seus vídeos (cascade)
- `file_size = 10737418240` é persistido e lido como o número `10737418240`

---

### SI-03.5 — Pré-cadastro do rascunho e retomada do upload (VideosService)

**Description:** Implementa no `VideosService` o início do upload (pré-cadastro como `draft` + multipart + URLs das partes) e o estado de retomada, com o id público único gerado pelo sistema.

**Technical actions:**

1. Adicionar `findByUserId(userId)` em `src/channels/channels.service.ts` — a busca do canal do usuário pertence ao domínio de canais (Single Responsibility)
2. Criar `src/videos/public-id.util.ts` — `generatePublicId()` = `randomBytes(8).toString('base64url')` (11 chars) (per `phase-03-videos/TD-05`)
3. Criar `src/videos/videos.service.ts` → `createDraft(userId, dto)`: resolve o canal (`CHANNEL_NOT_FOUND` se ausente), insere o vídeo `draft` com `storage_key = videos/{id}/original` e retry de `public_id` em `23505` (até 5 tentativas, mesmo padrão de `phase-02-auth/TD-10`), chama `createMultipartUpload`, grava `upload_id` e devolve `upload` com `partSize = 104857600`, `partCount`, `expiresIn = 3600` e as URLs pré-assinadas de todas as partes (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`)
4. `getUploadState(userId, publicId)`: carrega o vídeo do dono (`VIDEO_NOT_FOUND` para inexistente/não-dono), exige `draft` (`VIDEO_NOT_DRAFT`), chama `listParts` e devolve `uploadedParts` + URLs novas só das partes faltantes (per `phase-03-videos/TD-02` Revision 2026-11-04)
5. Criar `src/videos/exceptions/video.exceptions.ts` com `ChannelNotFoundException`, `VideoNotFoundException`, `VideoNotDraftException`, `VideoNotReadyException`, `UploadIncompleteException`, `UploadSizeMismatchException` estendendo `DomainException` com os códigos do `### Error Catalog` (per `phase-02-auth/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: 11 chars no alfabeto base64url | `src/videos/public-id.util.spec.ts` |
| `VideosService` (createDraft/getUploadState) | Unit: branches — sem canal, colisão de `public_id` com retry, não-dono, status ≠ draft, cálculo de `partCount` | `src/videos/videos.service.spec.ts` |
| `VideosService` (createDraft/getUploadState) | Integration: DB + MinIO reais — rascunho persistido com `upload_id`; retomada lista a parte enviada e omite sua URL | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário / `null` | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — `StorageService`; SI-03.4 — entidade `Video`

**Acceptance criteria:**

- `createDraft` com `fileSize = 262144000` (250 MiB) persiste um vídeo `draft` e devolve `partCount = 3` com 3 URLs
- O `public_id` gerado tem 11 caracteres `[A-Za-z0-9_-]` e uma colisão no índice único gera novo id sem erro para o cliente
- Usuário sem canal recebe `CHANNEL_NOT_FOUND`
- `getUploadState` de um não-dono resulta em `VIDEO_NOT_FOUND`; de um vídeo `processing` resulta em `VIDEO_NOT_DRAFT`
- Após enviar a parte 1, `getUploadState` retorna `uploadedParts` com a parte 1 e nenhuma URL para ela

---

### SI-03.6 — Conclusão do upload e publicação do job (fila)

**Description:** Conclui o multipart, valida o tamanho, move o vídeo para `processing` e publica o job `process-video` na fila `video-processing`.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` (conexão via `queueConfig.KEY`) num `src/queue/queue.module.ts` reutilizável por API e worker, e `BullModule.registerQueue({ name: 'video-processing' })` com as opções default do job do `### Events/Messages` (per `phase-03-videos/TD-01`; `library-refs.md` → @nestjs/bullmq)
2. Criar `src/videos/video-processing.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'` e a interface `ProcessVideoJobData { videoId: string }`
3. `VideosService.completeUpload(userId, publicId, parts)`: dono + `draft` obrigatórios; `completeMultipartUpload` (mapeia `StorageInvalidPartsError` → `UPLOAD_INCOMPLETE`); `headObjectSize` ≠ `file_size` → `UPLOAD_SIZE_MISMATCH`; persiste `status = processing` e `upload_id = null`; só então `queue.add(PROCESS_VIDEO_JOB, { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: 1000 })` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`)
4. Se `queue.add` falhar, reverter o status para `draft` antes de propagar o erro, para que o cliente possa tentar concluir de novo

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branches — partes inválidas, tamanho divergente, falha no enqueue reverte para `draft`, job publicado com payload e opções | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: DB + MinIO + Redis reais — status `processing` persistido e job `process-video` presente na fila com `{ videoId }` | `src/videos/videos.service.integration-spec.ts` |
| `QueueModule` | Unit: compilação do módulo com config de teste | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.5 — `VideosService` e exceções de vídeo

**Acceptance criteria:**

- Concluir um upload válido muda o status para `processing`, zera `upload_id` e publica exatamente um job `process-video` com `{ videoId }`
- Concluir com ETag inválido resulta em `UPLOAD_INCOMPLETE` e o vídeo continua `draft`
- Objeto montado com tamanho diferente do declarado resulta em `UPLOAD_SIZE_MISMATCH` sem publicar job
- Falha ao publicar o job deixa o vídeo em `draft`

---

### SI-03.7 — Endpoints de upload (POST /videos, retomada e conclusão)

**Route:** POST /videos · GET /videos/:publicId/upload · POST /videos/:publicId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated (POST /videos); Owner (retomada e conclusão) — per `### Authorization Matrix`

**Description:** Expõe o handshake de upload direto ao storage via HTTP, delegando toda regra ao `VideosService`.

**Technical actions:**

1. Criar DTOs em `src/videos/dto/`: `create-video.dto.ts` (`title`, `fileName`, `fileSize`, `contentType`) e `complete-upload.dto.ts` (`parts[]` com `partNumber`, `etag`) com as regras do `#### Validation Rules — videos`, e DTOs de resposta (`video-upload-response.dto.ts`, `upload-state-response.dto.ts`, `video-summary-response.dto.ts`) espelhando o `### API Contracts` (per `phase-02-auth/TD-06`)
2. Criar `src/videos/videos.controller.ts` com `POST /videos` (201), `GET /videos/:publicId/upload` (200) e `POST /videos/:publicId/upload/complete` (202), usando `@CurrentUser()` e delegando a `createDraft`/`getUploadState`/`completeUpload`
3. Criar `src/videos/videos.module.ts` (TypeORM `Video`, `ChannelsModule`, `StorageModule`, `QueueModule`) e registrá-lo no `AppModule`
4. Documentar os endpoints com `@ApiTags('videos')`, `@ApiBearerAuth()` e respostas de erro com o envelope comum; regenerar `openapi.json` com `npm run openapi:export` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilação do módulo (DI de storage, fila e canais) | `src/videos/videos.module.spec.ts` |

_E2E scenarios for these routes are authored by `/plan-test-specs` in the spec referenced by `**Test Specs:**`._

**Dependencies:** SI-03.6 — `completeUpload` e `QueueModule`

**Acceptance criteria:**

- `POST /videos` autenticado com payload válido retorna `201` com `status: "draft"`, `publicId` de 11 chars e `upload.parts` com URLs pré-assinadas
- `POST /videos` com `fileSize: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`; com `contentType: "image/png"` também `400`
- `POST /videos` sem token retorna `401`
- `GET /videos/:publicId/upload` por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `POST /videos/:publicId/upload/complete` com as partes enviadas retorna `202` com `status: "processing"`; repetir a chamada retorna `409` com `error: "VIDEO_NOT_DRAFT"`
- O vídeo de 10GB nunca trafega pela API: nenhum endpoint aceita corpo binário (apenas JSON)

---

### SI-03.8 — Extração de metadados e thumbnail com FFmpeg (MediaProbeService)

**Description:** Adapter que invoca `ffprobe`/`ffmpeg` do sistema sobre uma URL HTTP do storage, sem copiar o arquivo inteiro para o disco.

**Technical actions:**

1. Criar `src/video-processing/media-probe.service.ts` → `probe(url)`: `spawn('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', url])`, parse do JSON para `{ durationSeconds, metadata: { formatName, bitRate, width, height, videoCodec, audioCodec, frameRate } }`; arquivo sem stream de vídeo ou sem duração → `MediaProbeError` (per `phase-03-videos/TD-04`)
2. `captureThumbnail(url, durationSeconds)`: `spawn('ffmpeg', ['-ss', t, '-i', url, '-frames:v','1','-vf','scale=1280:-2','-f','image2pipe','-vcodec','mjpeg','pipe:1'])` com `t = min(duration * 0.1, max(duration - 1, 0))`, retornando um `Buffer` JPEG (per `phase-03-videos/TD-04`)
3. Erros de processo (exit code ≠ 0, stderr) e timeout configurável viram `MediaProbeError` com mensagem curta

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Integration: ffprobe/ffmpeg reais sobre vídeo sintético gerado no teste (`ffmpeg -f lavfi testsrc`) servido do MinIO via `presignInternalGet` — duração ≈ esperada, codec/resolução corretos, JPEG válido (magic `FFD8`) com largura 1280; arquivo não-vídeo → `MediaProbeError` | `src/video-processing/media-probe.service.integration-spec.ts` |
| `MediaProbeService` | Unit: cálculo do instante do thumbnail para vídeos curtos e longos | `src/video-processing/media-probe.service.spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg na imagem; SI-03.3 — `presignInternalGet` para servir o arquivo de teste

**Acceptance criteria:**

- `probe` de um vídeo de 4 s 640x360 H.264 retorna `durationSeconds` entre 3.9 e 4.1, `width = 640`, `height = 360`, `videoCodec = "h264"`
- `captureThumbnail` desse vídeo retorna um JPEG de 1280 px de largura
- `probe` de um arquivo de texto lança `MediaProbeError`
- Nenhum arquivo temporário do tamanho do vídeo é gravado no disco do worker

---

### SI-03.9 — Video worker: consumidor da fila em processo e container próprios

**Description:** Cria o processo do worker (entrypoint separado, mesmo código-fonte) que consome `process-video`, extrai metadados, gera o thumbnail e conclui o ciclo de status, rodando como serviço `video-worker` no Compose.

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` → `processVideo(videoId, { isFinalAttempt })`: carrega o vídeo (ignora se não estiver `processing`), `presignInternalGet` do original, `MediaProbeService.probe` + `captureThumbnail`, `putObject` em `videos/{id}/thumbnail.jpg`, persiste `duration_seconds`, `metadata`, `thumbnail_key` e `status = ready`; em erro, se `isFinalAttempt`, persiste `status = failed` + `processing_error` (≤ 500 chars) e relança (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
2. Criar `src/video-processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`; `process(job)` delega a `processVideo(job.data.videoId, { isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) })` (per `phase-03-videos/TD-01`; `library-refs.md` → @nestjs/bullmq, bullmq)
3. Criar `src/video-processing/video-processing.module.ts` e `src/worker.module.ts` (Config, TypeORM, `QueueModule`, `StorageModule`, `VideoProcessingModule` — sem controllers) e `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()` (per `phase-03-videos/TD-03`)
4. Adicionar scripts `start:worker` / `start:worker:dev` no `package.json` (build do worker em diretório de saída próprio para não conflitar com o watch da API)
5. Adicionar serviço `video-worker` ao `compose.yaml` (mesmo build `Dockerfile.dev`, mesmo volume do código, `command` que inicia o worker, `depends_on` db/redis healthy e `minio-init` concluído, `restart: unless-stopped`) (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: branches — vídeo ausente/fora de `processing` é ignorado; falha intermediária relança sem mudar status; falha final grava `failed` + `processing_error` truncado | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: DB + MinIO + FFmpeg reais — vídeo sintético `processing` termina `ready` com duração, metadados e `thumbnail.jpg` no bucket; arquivo inválido na tentativa final termina `failed` | `src/video-processing/video-processing.service.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo do worker (DI de fila, storage e processor) | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.6 — fila e contrato do job; SI-03.8 — `MediaProbeService`

**Acceptance criteria:**

- `docker compose up -d` deixa o serviço `video-worker` em execução e conectado ao Redis
- Um job `process-video` para um vídeo válido em `processing` resulta em `status = ready`, `duration_seconds` preenchido, `metadata.width/height` preenchidos e objeto `videos/{id}/thumbnail.jpg` no bucket
- Um job para um arquivo não-vídeo resulta em `status = failed` com `processing_error` preenchido somente após a 3ª tentativa
- Reprocessar o mesmo job de um vídeo `ready` não altera o registro

---

### SI-03.10 — Endpoints públicos: detalhes, streaming e download

**Route:** GET /videos/:publicId · GET /videos/:publicId/stream · GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Anonymous (`@Public()`) — per `### Authorization Matrix`

**Description:** Resolve a URL única do vídeo e entrega reprodução via streaming e download por redirecionamento a URLs pré-assinadas, sem passar bytes pela API.

**Technical actions:**

1. `VideosService.getPublicDetails(publicId)`: `VIDEO_NOT_FOUND` para id inexistente/malformado; devolve os campos do `### API Contracts → GET /videos/:publicId` com `thumbnailUrl` pré-assinado (público, 3600 s) apenas quando `ready` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
2. `VideosService.getStreamUrl(publicId)` e `getDownloadUrl(publicId)`: exigem `ready` (`VIDEO_NOT_READY`) e devolvem `presignGet` do original — inline para stream, com `downloadFileName = original_file_name` para download (per `phase-03-videos/TD-06`, `phase-03-videos/TD-09`)
3. Adicionar ao `VideosController` `GET /videos/:publicId` (200), `GET /videos/:publicId/stream` (302) e `GET /videos/:publicId/download` (302) com `@Public()` e `res.redirect(302, url)`; DTO de resposta `video-details-response.dto.ts` (per `phase-03-videos/TD-06` Revision 2026-11-04)
4. Documentar os três endpoints no Swagger e regenerar `openapi.json` (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (detalhes/stream/download) | Unit: branches — inexistente, não-`ready`, `thumbnailUrl` nulo fora de `ready`, `downloadFileName` repassado | `src/videos/videos.service.spec.ts` |

_E2E scenarios for these routes are authored by `/plan-test-specs` in the spec referenced by `**Test Specs:**`._

**Dependencies:** SI-03.7 — `VideosController`/`VideosModule`; SI-03.9 — vídeos chegam a `ready` pelo worker

**Acceptance criteria:**

- `GET /videos/:publicId` anônimo de um vídeo `ready` retorna `200` com `durationSeconds`, `metadata` e `thumbnailUrl`
- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `302` cujo `Location`, requisitado com `Range: bytes=0-1023`, responde `206` com `Content-Range` e 1024 bytes
- `GET /videos/:publicId/download` retorna `302` cujo `Location` responde com `Content-Disposition: attachment; filename="{original_file_name}"`
- `GET /videos/:publicId/stream` de um vídeo `processing` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/zzzzzzzzzzz` retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.11 — Documentação de IA e do projeto (CLAUDE.md)

**Description:** Atualiza a documentação de IA para refletir o estado real do código após a fase: módulo de vídeos, endpoints, fila/worker e storage.

**Technical actions:**

1. Atualizar `CLAUDE.md` (raiz) — arquitetura: Message Queue resolvida como BullMQ + Redis, Video Worker e Object Storage (MinIO) implementados; seção de vídeos com o fluxo upload → processamento → streaming (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
2. Atualizar `nestjs-project/CLAUDE.md` — serviços do Compose (`minio`, `minio-init`, `redis`, `video-worker`) com portas e checks de prontidão, comandos do worker, variáveis `S3_*`/`REDIS_*` (incluindo a distinção endpoint interno × público), módulos `storage`, `queue`, `videos`, `video-processing` e tabela de endpoints de vídeo (per `phase-03-videos/TD-09`)
3. Atualizar `README.md` — status da Fase 03, serviços/portas e endpoints de vídeo
4. Verificar que todo arquivo, comando e endpoint citado nos documentos existe no código (nenhuma referência inexistente)

**Tests:** _(empty — documentation only; verified by AC 4 against the code)_

**Dependencies:** SI-03.10 — documentação reflete o código final

**Acceptance criteria:**

- `CLAUDE.md` não descreve mais a fila como "TBD" e cita BullMQ + Redis, MinIO e o `video-worker`
- `nestjs-project/CLAUDE.md` lista os 6 endpoints de vídeo com método, rota e autorização idênticos ao `VideosController`
- Todo caminho de arquivo citado nos dois `CLAUDE.md` existe no repositório

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → `channels.id` ON DELETE CASCADE, not null |
| public_id | varchar(11) | unique, not null — 11-char base64url id generated via `node:crypto` (per `phase-03-videos/TD-05`) |
| title | varchar(100) | not null (per `phase-03-videos/TD-02` Revision 2026-11-04) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-07`) |
| original_file_name | varchar(255) | not null |
| content_type | varchar(100) | not null — `video/*` only |
| file_size | bigint | not null — declared size in bytes, ≤ 10 GiB (10737418240) (per `phase-03-videos/TD-02`) |
| storage_key | varchar(512) | not null — `videos/{id}/original` (per `phase-03-videos/TD-08`) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId`; set while `draft`, cleared on completion |
| thumbnail_key | varchar(512) | nullable — `videos/{id}/thumbnail.jpg`, set when `ready` (per `phase-03-videos/TD-08`) |
| duration_seconds | double precision | nullable — set when `ready` (per `phase-03-videos/TD-04`) |
| metadata | jsonb | nullable — ffprobe summary: `formatName`, `bitRate`, `width`, `height`, `videoCodec`, `audioCodec`, `frameRate` (per `phase-03-videos/TD-04`) |
| processing_error | varchar(500) | nullable — set only when `failed` (per `phase-03-videos/TD-07`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), auto-updated |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id`.
**Indexes:** unique on `public_id`; index on `channel_id`.
**Migration:** `<timestamp>-CreateVideos.ts` creates the enum type, the table, the FK and the indexes; `down` drops them in reverse order (table, then enum type).

**Status lifecycle** (per `phase-03-videos/TD-07`):

```
draft ──(POST /videos/:publicId/upload/complete)──▶ processing ──(worker success)──▶ ready
                                                        └──(worker final attempt fails)──▶ failed
```

### API Contracts

All error responses follow the inherited envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`); validation failures return `400` with `error: "VALIDATION_ERROR"` and `message: string[]`. Every endpoint is documented with `@nestjs/swagger` decorators and `openapi.json` is re-exported (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`).

#### POST /videos (SI-03.7)

Pré-cadastro do vídeo como rascunho + início do upload multipart direto ao storage (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer {accessToken}
- Content-Type: application/json

**Request body:**
- title: string, required — 1..100 characters, trimmed
- fileName: string, required — 1..255 characters
- fileSize: integer, required — 1..10737418240 (10 GiB)
- contentType: string, required — must match `^video\/[\w.+-]+$`

**Response 201:**
- id: string (uuid)
- publicId: string (11 chars)
- title: string
- status: `"draft"`
- upload: object
  - partSize: integer — 104857600 (100 MiB) (per `phase-03-videos/TD-02`)
  - partCount: integer — `ceil(fileSize / partSize)`
  - expiresIn: integer — seconds the part URLs remain valid (3600)
  - parts: array of `{ partNumber: integer, url: string }` — one presigned `UploadPart` URL per part, signed with the public endpoint (per `phase-03-videos/TD-09`)

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (missing title, `fileSize` > 10 GiB, non-`video/*` content type)
- 401 Unauthorized: missing or invalid access token (inherited `JwtAuthGuard` — Nest default `{ statusCode: 401, message: "Unauthorized" }` body)
- 404 CHANNEL_NOT_FOUND: authenticated user has no channel

---

#### GET /videos/:publicId/upload (SI-03.7)

Retomada do upload interrompido (per `phase-03-videos/TD-02` Revision 2026-11-04).

**Request headers:**
- Authorization: Bearer {accessToken}

**Response 200:**
- publicId: string
- status: `"draft"`
- partSize: integer
- partCount: integer
- expiresIn: integer
- uploadedParts: array of `{ partNumber: integer, etag: string, size: integer }` — from `ListParts`
- parts: array of `{ partNumber: integer, url: string }` — fresh presigned URLs only for parts not yet uploaded

**Error responses:**
- 401 Unauthorized: missing or invalid access token (inherited `JwtAuthGuard` — Nest default `{ statusCode: 401, message: "Unauthorized" }` body)
- 404 VIDEO_NOT_FOUND: no video with this `publicId`, or the caller is not the owner
- 409 VIDEO_NOT_DRAFT: the upload was already completed (status ≠ `draft`)

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Conclusão do upload: `CompleteMultipartUpload`, verificação de tamanho com `HeadObject`, transição `draft → processing` e publicação do job (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer {accessToken}
- Content-Type: application/json

**Request body:**
- parts: array, required, 1..10000 items
  - partNumber: integer, required — 1..10000
  - etag: string, required — non-empty

**Response 202:**
- id: string (uuid)
- publicId: string
- title: string
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation
- 401 Unauthorized: missing or invalid access token (inherited `JwtAuthGuard` — Nest default `{ statusCode: 401, message: "Unauthorized" }` body)
- 404 VIDEO_NOT_FOUND: no video with this `publicId`, or the caller is not the owner
- 409 VIDEO_NOT_DRAFT: the upload was already completed
- 422 UPLOAD_INCOMPLETE: storage rejected the part list (missing/invalid part or ETag)
- 422 UPLOAD_SIZE_MISMATCH: stored object size differs from the declared `fileSize`

---

#### GET /videos/:publicId (SI-03.10)

Detalhes públicos do vídeo pela URL única (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06` Revision 2026-11-04).

**Response 200:**
- publicId: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- durationSeconds: number | null
- metadata: object | null
- thumbnailUrl: string | null — presigned GET URL (public endpoint, 3600 s) when `ready`
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `publicId`

---

#### GET /videos/:publicId/stream (SI-03.10)

Reprodução via streaming: redireciona para URL pré-assinada; o storage atende `Range` com `206 Partial Content` (per `phase-03-videos/TD-06`).

**Response 302:**
- Location: presigned `GetObject` URL (public endpoint, `expiresIn` 3600 s, inline)

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `publicId`
- 409 VIDEO_NOT_READY: status ≠ `ready`

---

#### GET /videos/:publicId/download (SI-03.10)

Download do arquivo original (per `phase-03-videos/TD-06`).

**Response 302:**
- Location: presigned `GetObject` URL (public endpoint, 3600 s) with `ResponseContentDisposition: attachment; filename="{original_file_name}"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: no video with this `publicId`
- 409 VIDEO_NOT_READY: status ≠ `ready`

---

#### Validation Rules — videos

- `title`: required, string, trimmed, 1..100 characters
- `fileName`: required, string, 1..255 characters
- `fileSize`: required, integer, min 1, max 10737418240
- `contentType`: required, string, matches `^video\/[\w.+-]+$`
- `parts`: required array, 1..10000 items; each `partNumber` integer 1..10000, `etag` non-empty string
- `:publicId` path param: string matching `^[A-Za-z0-9_-]{11}$` — anything else yields `404 VIDEO_NOT_FOUND`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | — |
| GET /videos/:publicId/upload | ✗ | ✗ (404) | ✓ |
| POST /videos/:publicId/upload/complete | ✗ | ✗ (404) | ✓ |
| GET /videos/:publicId | ✓ | ✓ | ✓ |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download | ✓ | ✓ | ✓ |

Owner = the user whose channel (`channels.user_id = JwtPayload.sub`) owns the video. Non-owners receive `404 VIDEO_NOT_FOUND` (no existence leak). Public endpoints use `@Public()` to opt out of the global `JwtAuthGuard` (per `phase-03-videos/TD-06` Revision 2026-11-04; inherited `phase-02-auth/TD-02`).

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VALIDATION_ERROR | 400 | Request body/params fail DTO validation (inherited) |
| _(Nest default `Unauthorized`)_ | 401 | Missing/invalid access token on protected endpoints — thrown by the inherited global `JwtAuthGuard` as `UnauthorizedException`, not a domain code |
| CHANNEL_NOT_FOUND | 404 | Authenticated user has no channel when pre-registering a video |
| VIDEO_NOT_FOUND | 404 | Unknown `publicId`, malformed `publicId`, or caller is not the owner on owner-only endpoints |
| VIDEO_NOT_DRAFT | 409 | Resume or complete called on a video whose status ≠ `draft` |
| VIDEO_NOT_READY | 409 | Stream or download requested for a video whose status ≠ `ready` |
| UPLOAD_INCOMPLETE | 422 | `CompleteMultipartUpload` rejected the part list (S3 `InvalidPart` / `InvalidPartOrder` / `NoSuchUpload`) |
| UPLOAD_SIZE_MISMATCH | 422 | `HeadObject` size of the assembled object differs from the declared `file_size` |

### Events/Messages

#### video-processing → process-video

**Queue:** `video-processing` (BullMQ on Redis, per `phase-03-videos/TD-01`)
**Job name:** `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `attempts: 3`, `backoff: { type: "exponential", delay: 1000 }`, `removeOnComplete: true`, `removeOnFail: 1000` (per `phase-03-videos/TD-07`, `library-refs.md` → bullmq).
**Producer:** `VideosService.completeUpload` — after the status is persisted as `processing` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`)
**Consumer:** `VideoProcessingProcessor` in the `video-worker` process (per `phase-03-videos/TD-03`)
**Trigger:** successful `CompleteMultipartUpload` + size check on `POST /videos/:publicId/upload/complete`
**Processing:** ffprobe over a presigned GET URL signed with the internal endpoint → `duration_seconds` + `metadata`; ffmpeg grabs one frame at 10% of the duration (capped to the last second), JPEG 1280 px wide → `PutObject` at `videos/{id}/thumbnail.jpg`; then status `ready` (per `phase-03-videos/TD-04`). Idempotent: re-running overwrites metadata and thumbnail.
**Failure:** intermediate attempt failures rethrow (BullMQ retries); on the final attempt (`attemptsMade + 1 >= attempts`) the consumer sets status `failed` and `processing_error` (truncated to 500 chars) before rethrowing (per `phase-03-videos/TD-07`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`)

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (env keys and services must exist)
│   └── SI-03.3 — depends on SI-03.2 (storage config + AWS SDK)
│       ├── SI-03.5 — depends on SI-03.3 + SI-03.4 (draft pre-registration needs storage + entity)
│       │   └── SI-03.6 — depends on SI-03.5 (completion extends VideosService; adds the queue)
│       │       ├── SI-03.7 — depends on SI-03.6 (controller wires create/resume/complete)
│       │       │   └── SI-03.10 — depends on SI-03.7 + SI-03.9 (public endpoints extend the controller; need ready videos)
│       │       │       └── SI-03.11 — depends on SI-03.10 (docs reflect final code)
│       │       └── SI-03.9 — depends on SI-03.6 + SI-03.8 (worker consumes the job contract; uses MediaProbeService)
│       └── SI-03.8 — depends on SI-03.1 + SI-03.3 (FFmpeg in the image; presignInternalGet serves test media)
SI-03.4 (root, independent — DB only)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage, broker e FFmpeg no Compose
- [ ] SI-03.2 — Infra: dependências e configuração de storage e fila
- [ ] SI-03.3 — Serviço de object storage (StorageModule)
- [ ] SI-03.4 — Entidade Video e migration CreateVideos
- [ ] SI-03.5 — Pré-cadastro do rascunho e retomada do upload (VideosService)
- [ ] SI-03.6 — Conclusão do upload e publicação do job (fila)
- [ ] SI-03.7 — Endpoints de upload (POST /videos, retomada e conclusão)
- [ ] SI-03.8 — Extração de metadados e thumbnail com FFmpeg (MediaProbeService)
- [ ] SI-03.9 — Video worker: consumidor da fila em processo e container próprios
- [ ] SI-03.10 — Endpoints públicos: detalhes, streaming e download
- [ ] SI-03.11 — Documentação de IA e do projeto (CLAUDE.md)

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)

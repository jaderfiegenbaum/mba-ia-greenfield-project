---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload.e2e-spec.ts
---

# Videos Upload Endpoints Test Plan

## Application Overview

Handshake de upload direto ao object storage: `POST /videos` pré-cadastra o vídeo como rascunho e devolve URLs pré-assinadas de `UploadPart`; `GET /videos/:publicId/upload` permite retomar um upload interrompido; `POST /videos/:publicId/upload/complete` conclui o multipart, valida o tamanho, move o vídeo para `processing` e publica o job na fila. Os bytes do vídeo vão do cliente direto ao MinIO — a API só troca JSON.

## Test Scenarios

### 1. POST /videos — pré-cadastro do rascunho

**Setup:** `beforeEach` limpa `videos`, `channels`, `users`, `refresh_tokens`, `verification_tokens`; cria usuário confirmado + canal e obtém access token via `POST /auth/login`; app Nest com `ValidationPipe` e filtros globais iguais ao `main.ts`; `S3_PUBLIC_ENDPOINT` apontando para o endpoint interno (o teste roda dentro da rede do Compose).

#### 1.1. creates-draft-with-presigned-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. POST /videos com Bearer token e body `{ title: "Meu vídeo", fileName: "clip.mp4", fileSize: 262144000, contentType: "video/mp4" }`
    - expect: status 201
    - expect: `status` = `"draft"`, `publicId` casa `^[A-Za-z0-9_-]{11}$`
    - expect: `upload.partSize` = 104857600, `upload.partCount` = 3, `upload.parts` tem 3 itens com `partNumber` 1..3 e `url` http
  2. Consultar a tabela `videos` pelo `publicId`
    - expect: linha com `status = draft`, `upload_id` não nulo, `storage_key = videos/{id}/original`

#### 1.2. rejects-invalid-body

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. POST /videos com `fileSize: 10737418241`
    - expect: status 400, `error` = `"VALIDATION_ERROR"`
  2. POST /videos com `contentType: "image/png"`
    - expect: status 400, `error` = `"VALIDATION_ERROR"`
  3. POST /videos sem `title`
    - expect: status 400, `error` = `"VALIDATION_ERROR"`

#### 1.3. requires-authentication

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. POST /videos com body válido e sem header Authorization
    - expect: status 401
    - expect: nenhuma linha criada em `videos`

### 2. GET /videos/:publicId/upload — retomada

**Setup:** mesmo do grupo 1, mais um segundo usuário confirmado com canal e token próprio.

#### 2.1. resume-hidden-from-non-owner

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. Usuário A cria um rascunho via POST /videos
    - expect: status 201
  2. Usuário B chama GET /videos/{publicId}/upload
    - expect: status 404, `error` = `"VIDEO_NOT_FOUND"`
  3. Usuário A chama GET /videos/{publicId}/upload
    - expect: status 200, `status` = `"draft"`, `uploadedParts` vazio, `parts` com todas as partes

### 3. POST /videos/:publicId/upload/complete — conclusão

**Setup:** mesmo do grupo 1; arquivo pequeno (≤ 1 parte) gerado em memória com bytes de vídeo sintético; a fila `video-processing` é limpa antes de cada teste.

#### 3.1. completes-upload-and-enqueues-processing

**Covers AC:** #5, #6
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. POST /videos com `fileSize` igual ao tamanho do arquivo e `partCount` 1
    - expect: status 201
  2. PUT do arquivo na URL da parte 1 diretamente no storage (fora da API)
    - expect: status 200 do storage com header `ETag`
  3. GET /videos/{publicId}/upload
    - expect: `uploadedParts` contém a parte 1 e `parts` vazio
  4. POST /videos/{publicId}/upload/complete com `{ parts: [{ partNumber: 1, etag }] }`
    - expect: status 202, `status` = `"processing"`
    - expect: tabela `videos` com `status = processing` e `upload_id` nulo
    - expect: um job `process-video` com `{ videoId }` na fila `video-processing`
  5. Repetir POST /videos/{publicId}/upload/complete
    - expect: status 409, `error` = `"VIDEO_NOT_DRAFT"`

#### 3.2. rejects-invalid-parts

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. Criar rascunho e enviar a parte 1 ao storage
    - expect: ETag recebido
  2. POST /videos/{publicId}/upload/complete com `etag` adulterado
    - expect: status 422, `error` = `"UPLOAD_INCOMPLETE"`
    - expect: vídeo continua `draft`

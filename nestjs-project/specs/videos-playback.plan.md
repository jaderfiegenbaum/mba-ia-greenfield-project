---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-playback.e2e-spec.ts
---

# Videos Playback Endpoints Test Plan

## Application Overview

Endpoints públicos (anônimos) da URL única do vídeo: `GET /videos/:publicId` devolve detalhes e thumbnail; `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` redirecionam (302) para URLs pré-assinadas do storage, que atende `Range` com `206 Partial Content` — a API nunca transmite os bytes do vídeo.

## Test Scenarios

### 1. Fluxo completo até `ready` e reprodução

**Setup:** `beforeEach` limpa as tabelas; usuário confirmado + canal + token; vídeo sintético MP4 (4 s, 640x360, gerado com `ffmpeg -f lavfi testsrc`) enviado pelo handshake de upload; conclusão do upload publica o job e o serviço `video-worker` do Compose processa; o teste aguarda (polling, timeout 60 s) `GET /videos/:publicId` responder `status: "ready"`. `S3_PUBLIC_ENDPOINT` aponta para o endpoint interno (o teste roda na rede do Compose).

#### 1.1. ready-video-details-are-public

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. GET /videos/{publicId} sem Authorization
    - expect: status 200, `status` = `"ready"`
    - expect: `durationSeconds` entre 3.9 e 4.1; `metadata.width` = 640, `metadata.height` = 360
    - expect: `thumbnailUrl` não nulo; GET nessa URL retorna 200 com `Content-Type` `image/jpeg`

#### 1.2. stream-redirects-to-range-capable-url

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. GET /videos/{publicId}/stream sem Authorization
    - expect: status 302 com header `Location`
  2. GET no `Location` com header `Range: bytes=0-1023`
    - expect: status 206, `Content-Range` começa com `bytes 0-1023/`, corpo com 1024 bytes

#### 1.3. download-redirects-with-attachment-disposition

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. GET /videos/{publicId}/download sem Authorization
    - expect: status 302 com header `Location`
  2. GET no `Location`
    - expect: status 200, `Content-Disposition` = `attachment; filename="clip.mp4"`, tamanho igual ao arquivo enviado

### 2. Vídeos indisponíveis

**Setup:** tabelas limpas; vídeo inserido diretamente em `processing` (sem passar pelo worker).

#### 2.1. not-ready-video-cannot-stream-or-download

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. GET /videos/{publicId}/stream
    - expect: status 409, `error` = `"VIDEO_NOT_READY"`
  2. GET /videos/{publicId}/download
    - expect: status 409, `error` = `"VIDEO_NOT_READY"`
  3. GET /videos/{publicId}
    - expect: status 200, `status` = `"processing"`, `thumbnailUrl` nulo

#### 2.2. unknown-public-id-returns-not-found

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-04T19:24:09Z

**Steps:**
  1. GET /videos/zzzzzzzzzzz
    - expect: status 404, `error` = `"VIDEO_NOT_FOUND"`
  2. GET /videos/zzzzzzzzzzz/stream
    - expect: status 404, `error` = `"VIDEO_NOT_FOUND"`

# Phase 03 — Upload e Processamento de Vídeos (Plano Executável)

Gerado pela skill `plan-build`. Rastreável a `technical-decisions-phase-03-videos.md`
(TD-01..08), `context.md`, `validation.md` (clean) e `library-refs.md`.

## Objective
Entregar o módulo de vídeos do StreamTube: upload de até 10GB sem travar a API (presigned
multipart direto ao storage), processamento assíncrono via fila+worker (duração/metadados +
thumbnail com FFmpeg), URL única por vídeo, streaming por range e download — com **MinIO,
Redis e worker** subindo no Compose e a tabela `videos` ligada ao canal.

Forma de referência do módulo: `src/auth/` (separação de camadas, DTOs, guard, filtro).

---

## Step Implementations

### SI-03.0 — Infra & deps: MinIO + Redis no Compose, config, instalação
1. `npm i @nestjs/bullmq bullmq @aws-sdk/client-s3 @aws-sdk/s3-request-presigner nanoid@3` (per `library-refs.md`; nanoid@3 por CJS).
2. Adicionar serviços ao `compose.yaml` (per `## Technical Specifications` → `### Infra (Compose)`): `redis` (redis:7-alpine, healthcheck), `minio` (minio/minio, portas 9000/9001, healthcheck), e `createbuckets` (job mc que cria o bucket `videos`). Hosts pelos service names (`redis`, `minio`) — nunca localhost (per CLAUDE.md Docker Networking).
3. Config tipada: `src/config/redis.config.ts` e `src/config/storage.config.ts` (`registerAs`, lendo `REDIS_HOST/PORT`, `MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET`); registrar no `env.validation` e no `.env.example` (per `nestjs-common-conventions`; env schema em `config/`).
4. Deliverable: `docker compose up -d` sobe api/db/mailpit/redis/minio + bucket criado. **Sem código de app ainda.**

### SI-03.1 — Data Model: entidade `Video` + migration `CreateVideos`
1. `src/videos/entities/video.entity.ts` — entidade `Video` (tabela `videos`) conforme `### Data Model`; relação `@ManyToOne(() => Channel)` (channel 1:N videos), `publicId` unique, enum `status` (per `.claude/rules/nestjs-entities.md`).
2. Migration `src/database/migrations/<ts>-CreateVideos.ts` criando a tabela + enum `videos_status_enum` + índices (`publicId` unique, `channelId`), FK `channelId → channels(id)` ON DELETE CASCADE (per `.claude/rules/typeorm-migrations.md`; padrão da migration de auth).
3. Registrar a entidade no DataSource/módulo. `to_dict`/serialização pública **sem** `storageKey` interno.
4. Tests: `video.entity.integration-spec.ts` (persistência real, unique de publicId, FK ao canal) + a suite de migrations cobre a nova migração.
   DoD do SI: `migration:run` aplica limpo; entity integration verde.

### SI-03.2 — Storage service (S3/MinIO)
1. `src/videos/storage/storage.service.ts` — `S3Client` (endpoint `minio`, `forcePathStyle`, region, credenciais de `storage.config`) (per `library-refs.md §2`).
2. Métodos: `ensureBucket()` (Head/Create no boot), `createMultipartUpload(key, contentType) → uploadId`, `presignUploadPart(key, uploadId, partNumber) → url`, `completeMultipart(key, uploadId, parts)`, `abortMultipart(key, uploadId)`, `getObjectRange(key, range?) → { stream, contentRange, contentLength, contentType }`, `putObject(key, body, contentType)` (thumbnail), `buildKey(...)` (layout TD-03).
3. `StorageModule` provê o service; chaves `channels/{channelId}/videos/{videoId}/{source|thumbnails}/...` (per TD-03).
4. Tests: `storage.service.integration-spec.ts` contra o **MinIO real** do Compose (create/presign/put/getRange/abort) — não mockar (per CLAUDE.md testing).
   DoD do SI: integração verde contra MinIO.

### SI-03.3 — Fila: BullModule + producer
1. `BullModule.forRootAsync` no AppModule (connection via `redis.config`) + `BullModule.registerQueue({ name: 'video-processing' })` no `VideosModule` (per `library-refs.md §1`).
2. `src/videos/queue/video-queue.service.ts` — `@InjectQueue('video-processing')`; `enqueueProcessing(videoId)` com `attempts:3`, `backoff exponencial` (per TD-08).
3. Constantes em `videos.constants.ts` (nome da fila, do job) `as const` (per `nestjs-common-conventions`).
4. Tests: unit do producer (mock `Queue.add`) + integração leve (enfileira e checa contagem na fila real).

### SI-03.4 — Upload: iniciar (draft + multipart + presigned parts)
1. `POST /videos/uploads` (autenticado, dono do canal) — cria `Video` `draft` com `publicId` (nanoid), `storageKey`, abre `createMultipartUpload`, gera N URLs `presignUploadPart` e devolve `{ videoId, publicId, uploadId, key, parts:[{partNumber,url}] }` (per `### API Contracts` `#### POST /videos/uploads`; TD-02/TD-06).
2. DTO `initiate-upload.dto.ts` (title, contentType, partsCount|fileSize) validado (ValidationPipe).
3. Controller fino → `VideosService.initiateUpload(channelId, dto)`; regra no service (per `nestjs-layer-separation`).
4. Tests: unit service (mock storage/repo); e2e `POST /videos/uploads` (201 + shape; 401 sem token; 403 outro canal).

### SI-03.5 — Upload: concluir (complete multipart + enqueue)
1. `POST /videos/:publicId/uploads/complete` (dono) — recebe `{ parts:[{partNumber,eTag}] }`; `completeMultipart`; status `draft→uploaded`; `enqueueProcessing(videoId)` (per `### API Contracts`; `### Events/Messages`; TD-08).
2. Em falha do complete: `abortMultipart` + manter `draft` (compensação) (per `db-use-transactions`/error handling).
3. Tests: unit (mock storage+queue, verifica enqueue); e2e complete (200; enfileira; status `uploaded`).

### SI-03.6 — Worker: processamento (ffprobe + thumbnail) + container
1. `src/videos/worker/video.processor.ts` — `@Processor('video-processing')` extends `WorkerHost`: status `uploaded→processing`; baixa source (`getObjectRange` sem range → stream → arquivo temp, OQ-3); `ffprobe` (duração/metadados) e `ffmpeg` (thumbnail 1 frame) via `child_process` (TD-05); `putObject` thumbnail; status `→ready` com `durationSeconds`/`metadata`/`thumbnailKey`. `@OnWorkerEvent('failed')` → após esgotar `attempts`, `→failed` com `failureReason` (TD-08).
2. `src/videos/worker/main.ts` + `VideoWorkerModule` (standalone context, `enableShutdownHooks`) (per `library-refs.md §1`).
3. `Dockerfile.worker` (FROM node + `apt install ffmpeg`); serviço `video-worker` no Compose (depends_on db/redis/minio; mesmo código, command `node dist/videos/worker/main` ou ts-node em dev).
4. Tests: `video.processor.integration-spec.ts` — enfileira um vídeo com um MP4 pequeno real (fixture) no MinIO, roda o process(), e assere status `ready` + duração + thumbnail no storage (infra real).
   DoD do SI: worker sobe no Compose; integração de processamento verde.

### SI-03.7 — Consumo: metadata + streaming (range/206) + download
1. `GET /videos/:publicId` (`@Public()`) — metadados públicos do vídeo `ready` (404 se não `ready`/inexistente).
2. `GET /videos/:publicId/stream` (`@Public()`) — lê header `Range`; `getObjectRange`; responde `206 Partial Content` com `Content-Range`/`Accept-Ranges: bytes`/`Content-Length`/`Content-Type`, pipe do stream; sem `Range` → `200` (per TD-07; `### API Contracts`).
3. `GET /videos/:publicId/download` (`@Public()`) — mesmo stream com `Content-Disposition: attachment; filename=...`.
4. Só serve vídeos `ready` (senão `409`/`404`, per `### Error Catalog`).
5. Tests: e2e `stream` com header `Range` → 206 + `Content-Range`; sem range → 200; download → `Content-Disposition`; vídeo não-`ready` → erro correto.

### SI-03.8 — Fechamento do módulo + progress + DoD
1. `VideosModule` amarra controllers/services/storage/queue; registrar em `AppModule`; Swagger dos endpoints.
2. Rodar a **suíte completa** (`--runInBand`) + e2e + `tsc --noEmit` + `lint` (per CLAUDE.md DoD).
3. Atualizar `progress.md` (status + testes por SI) e o `CLAUDE.md` (seção de vídeos).

---

## Technical Specifications

### Data Model
Tabela `videos`:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK (default gen) | |
| `channelId` | uuid FK → `channels(id)` | ON DELETE CASCADE; index |
| `publicId` | varchar unique | nanoid(12) — URL única (TD-06) |
| `title` | varchar | |
| `status` | enum `videos_status_enum` | `draft\|uploaded\|processing\|ready\|failed` (TD-08) |
| `storageKey` | varchar | chave do source no bucket |
| `thumbnailKey` | varchar null | chave do thumbnail |
| `uploadId` | varchar null | id do multipart em andamento |
| `mimeType` | varchar null | |
| `sizeBytes` | bigint null | |
| `durationSeconds` | int null | do ffprobe |
| `metadata` | jsonb null | streams/format do ffprobe |
| `failureReason` | varchar null | quando `failed` |
| `createdAt`/`updatedAt` | timestamptz | |

### API Contracts
| Método | Rota | Auth | Corpo/Retorno |
|---|---|---|---|
| POST | `/videos/uploads` | dono do canal | in: `{title, contentType, fileSize\|partsCount}`; out `201` `{videoId, publicId, uploadId, key, parts:[{partNumber,url}]}` |
| POST | `/videos/:publicId/uploads/complete` | dono | in: `{parts:[{partNumber,eTag}]}`; out `200` `{publicId, status:'uploaded'}` |
| GET | `/videos/:publicId` | público | `200` metadados públicos (só `ready`) |
| GET | `/videos/:publicId/stream` | público | `206` (com Range) / `200`; corpo = bytes do vídeo |
| GET | `/videos/:publicId/download` | público | stream + `Content-Disposition: attachment` |

### Authorization Matrix
| Ação | Anônimo | Autenticado (outro canal) | Dono do canal |
|---|---|---|---|
| Iniciar/concluir upload | ✗ 401 | ✗ 403 | ✓ |
| GET metadados / stream / download (vídeo `ready`) | ✓ | ✓ | ✓ |
| Acesso a vídeo não-`ready` | ✗ 404/409 | ✗ | ✓ (dono pode ver status) |

### Error Catalog
| Código | Situação |
|---|---|
| 400 | DTO inválido (title/contentType/parts) |
| 401 | sem token em endpoint de escrita |
| 403 | autenticado mas não é dono do canal |
| 404 | `publicId` inexistente |
| 409 | complete de upload em estado inválido; stream/download de vídeo não-`ready` |
| 416 | `Range` inválido (fora do tamanho) |
| 422 | processamento falhou (worker) — refletido em `status=failed` |

### Events/Messages (fila)
- **Fila:** `video-processing` (BullMQ/Redis).
- **Job:** name `process-video`, payload `{ videoId: string }`.
- **Opções:** `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: true`.
- **Producer:** `VideoQueueService.enqueueProcessing(videoId)` (chamado no complete do upload).
- **Consumer:** `VideoProcessor.process(job)` — transições `uploaded→processing→ready`; em falha
  esgotando `attempts` → `failed` com `failureReason` (via `@OnWorkerEvent('failed')`).

### Infra (Compose)
Serviços novos: `redis` (redis:7-alpine + healthcheck), `minio` (console 9001, api 9000 +
healthcheck), `createbuckets` (minio/mc: cria bucket `videos`), `video-worker`
(`Dockerfile.worker` com ffmpeg; depends_on db/redis/minio). Hosts = service names.

---

## Dependency Map
```
SI-03.0 (infra+deps)
   └─> SI-03.1 (entity+migration)
         └─> SI-03.2 (storage)  ─┐
         └─> SI-03.3 (queue)    ─┤
                                 ├─> SI-03.4 (upload iniciar)
                                 │      └─> SI-03.5 (upload concluir → enqueue)
                                 │             └─> SI-03.6 (worker: processa) 
                                 │                    └─> SI-03.7 (metadata/stream/download)
                                 │                           └─> SI-03.8 (fechamento + DoD)
```
SI-03.2 e SI-03.3 dependem só de SI-03.0/03.1 e podem ser feitos em paralelo. SI-03.7 depende
de SI-03.6 (vídeo `ready` para servir). Testes sobem a cada SI (infra real do Compose).

## Deliverables
- Upload de até 10GB funcional (presigned multipart; byte não passa pela API).
- Processamento automático (duração/metadados) + thumbnail gerado.
- URL única por vídeo (`publicId`) sem conflito.
- Streaming (206/range) funcionando + download disponível.
- Ciclo de status `draft→uploaded→processing→ready|failed` no banco.
- `minio`, `redis`, `video-worker` subindo via `docker compose`.
- Migration cria `videos` (FK ao canal). Testes unit/integração/e2e verdes.
- DoD completa: suíte verde + `tsc --noEmit` 0 + `lint`. `progress.md` e `CLAUDE.md` atualizados.

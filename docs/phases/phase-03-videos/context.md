# Phase 03 — Context (Upload e Processamento de Vídeos)

Consolidação do contexto da fase (skill `plan-context`). Alimenta `plan-validate` e
`plan-build`. Rastreável às decisões em `docs/decisions/technical-decisions-phase-03-videos.md`
(TD-01..TD-08) e ao `docs/project-plan.md` (Fase 03).

## Objetivo da fase
Permitir que um canal faça upload de vídeos de até 10GB sem travar a API, com processamento
assíncrono (duração/metadados + thumbnail), URL única por vídeo, streaming por range e
download — com storage, fila e worker reais subindo no Docker.

## O que já existe (Fases 01/02 — não reescrever)
- **NestJS 11 + TypeORM + PostgreSQL 17** em `nestjs-project/`. Módulos: `auth/`, `users/`,
  `channels/`, `mail/`, `common/`, `config/`, `database/`, `swagger/`.
- **Canal 1:1 com usuário** (criado no cadastro). Vídeos pertencem a um **canal**.
- **JWT guard global** (`JwtAuthGuard` como `APP_GUARD`) + convenção `@Public()`; filtro de
  exceções de domínio; `ValidationPipe` global (`whitelist`); rate limiting (throttler);
  migrations versionadas + seeds.
- **Infra atual** (`nestjs-project/compose.yaml`): `nestjs-api`, `db` (postgres:17), `mailpit`.
- Rules em `.claude/rules/` (layer separation, entities, dtos, controllers, services,
  migrations, testing). Padrões: repository pattern, DI por construtor, `async/Promise<T>`.

## O que a Fase 03 adiciona (novo)
| Componente | Tecnologia (decisão) | Onde |
|---|---|---|
| Módulo de vídeos | NestJS (forma de referência: `auth/`) | `nestjs-project/src/videos/` |
| Tabela de vídeos | TypeORM migration | `src/database/migrations/<ts>-CreateVideos.ts` |
| Object storage | MinIO (S3-compat) — `@aws-sdk/client-s3` (TD-03) | serviço `videos/` + Compose `minio` |
| Fila | BullMQ + Redis — `@nestjs/bullmq` (TD-01) | Compose `redis` + producer no `videos/` |
| Worker | Container Nest standalone + FFmpeg (TD-04) | `src/videos/worker/` + Compose `video-worker` |

## Fluxo funcional (fim a fim)
1. **Iniciar upload** (autenticado, dono do canal): API cria o vídeo como `draft` com
   `publicId` (nanoid, TD-06), abre um **multipart** no storage (TD-02) e devolve as URLs
   pré-assinadas das partes + `uploadId`.
2. **Upload das partes**: cliente envia as partes **direto ao MinIO** (byte não passa pela
   API), suportando 10GB (TD-02).
3. **Concluir upload**: cliente chama a API com os ETags das partes; a API completa o
   multipart no storage, marca o vídeo como `uploaded` e **publica um job** na fila (TD-01).
4. **Processamento (worker)**: consome o job, marca `processing`, baixa/le o source do
   storage, roda `ffprobe` (duração/metadados) e `ffmpeg` (thumbnail de um frame, TD-05),
   sobe o thumbnail, atualiza o vídeo para `ready` (ou `failed` com motivo após retries, TD-08).
5. **Consumo**: `GET` por `publicId` retorna metadados; **streaming** por range → `206`
   (TD-07); **download** com `Content-Disposition: attachment`. Só vídeos `ready`.

## Data Model (esboço — detalhado no plano, Technical Specifications → Data Model)
Entidade `Video` (tabela `videos`), ligada a `channels`:
- `id` (uuid/pk), `channelId` (FK → channels), `publicId` (unique, nanoid),
- `title`, `status` (`draft|uploaded|processing|ready|failed`),
- `storageKey` (source), `thumbnailKey` (nullable), `uploadId` (multipart, nullable),
- `durationSeconds` (nullable), `sizeBytes` (nullable), `mimeType` (nullable),
- `metadata` (jsonb, nullable), `failureReason` (nullable),
- `createdAt`, `updatedAt`.

## Componentes de storage/fila (decisões)
- **Bucket** `videos`; chaves `channels/{channelId}/videos/{videoId}/source/{uuid}.{ext}` e
  `.../thumbnails/{uuid}.jpg` (TD-03). Bucket criado no bootstrap (MinIO).
- **Fila** `video-processing` (BullMQ). Job payload: `{ videoId }`. Retries + backoff (TD-08).
- **Worker** em container próprio com FFmpeg; consome `video-processing`.

## Restrições e regras herdadas (valem na fase)
- **Docker**: host = nome do serviço do Compose (`db`, `redis`, `minio`) — nunca `localhost`.
- **context7 obrigatório** antes de implementar com lib nova (versão instalada).
- **DoD**: unit + integração + e2e verdes, suíte completa verde, `tsc --noEmit` 0, `lint` 0.
- **Git Flow**: `feature/*` a partir de `dev`; sem commit na `main`.
- **Testes**: `*.spec.ts` (unit), `*.integration-spec.ts` (banco/serviços reais),
  `*.e2e-spec.ts` (supertest); integração/e2e com `--runInBand`. Não mockar o que dá para
  testar de verdade com a infra do Compose (MinIO/Redis reais).

## Autorização (esboço — matriz no plano)
- Iniciar/concluir upload, editar: **autenticado** e **dono do canal**.
- `GET` metadados / streaming / download: **público** (`@Public()`) para vídeos `ready`
  (acesso anônimo de leitura é premissa do produto — `project-plan.md`).

## Dependências novas (fixadas em library-refs.md via context7)
`@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `nanoid`,
`ioredis` (peer do BullMQ). FFmpeg/ffprobe: binários na imagem do worker (não pacote npm).

## Open questions (a resolver em plan-resolve → validation clean)
- OQ-1: versão exata de cada lib nova (context7) — vai para `library-refs.md`.
- OQ-2: `nanoid` v5 é ESM-only; confirmar interop com o CommonJS do projeto (ou fixar v3 CJS).
- OQ-3: como o worker acessa o source — download temporário vs. stream via presigned GET.
- OQ-4: nanoid vs uuid dado OQ-2 (fallback `crypto.randomUUID` se o interop atrapalhar).
- OQ-5: limites de parte do multipart (tamanho mínimo/nº de partes) para 10GB.

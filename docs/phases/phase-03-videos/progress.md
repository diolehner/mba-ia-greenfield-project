# Phase 03 — Progress

Progresso da implementação (skill `implement`), atualizado a cada SI com status + testes.
Formato conforme `docs/phases/phase-02-auth-frontend/progress.md`.

Legenda: ⬜ pendente · 🟡 em andamento · ✅ concluído (testes verdes)

| SI | Descrição | Status | Testes |
|----|-----------|--------|--------|
| SI-03.0 | Infra & deps (MinIO, Redis, config, install) | ✅ | infra up (redis/minio healthy, worker up, bucket `videos`); tsc 0 |
| SI-03.1 | Entidade `Video` + migration `CreateVideos` | ✅ | entity integration 6 verdes; migration aplica |
| SI-03.2 | Storage service (S3/MinIO) | ✅ | integração 5 verdes contra MinIO real |
| SI-03.3 | Fila BullMQ + producer | ✅ | unit + integração (Redis real) verdes |
| SI-03.4 | Upload: iniciar (draft + multipart + presigned) | ✅ | service unit + e2e (201/401/403/400) |
| SI-03.5 | Upload: concluir (complete + enqueue) | ✅ | e2e (200/403/404/409) + enqueue |
| SI-03.6 | Worker: ffprobe + thumbnail + container | ✅ | processor integration (MP4 real→ready+thumbnail); worker container ativo |
| SI-03.7 | Metadata + streaming (206/range) + download | ✅ | e2e 8: metadata, stream 206 c/ Content-Range, 200 sem range, download attachment, 404 |
| SI-03.8 | Fechamento do módulo + DoD | ✅ | suíte completa + e2e + tsc + lint verdes |

## Definition of Done (checklist final) — verificado
- ✅ `npm test -- --runInBand` — **29 suites, 166 testes**
- ✅ `npm run test:e2e` — **5 suites, 69 testes** (jest-e2e.json `maxWorkers:1`)
- ✅ `npx tsc --noEmit` código 0
- ✅ `npm run lint` (0 erros; warnings pré-existentes permitidos)
- ✅ `docker compose up -d` sobe api/db/mailpit/redis/minio/video-worker (healthy)
- ✅ `CLAUDE.md` (raiz e nestjs-project) atualizado com a seção de vídeos

## Deliverables da fase (todos atendidos)
- ✅ Upload de até 10GB sem travar a API (presigned multipart direto ao MinIO)
- ✅ Pré-cadastro do vídeo como `draft` ao iniciar o upload
- ✅ Processamento automático (duração/metadados via ffprobe) + thumbnail (ffmpeg)
- ✅ URL única por vídeo (`publicId` nanoid, coluna unique)
- ✅ Streaming (206/range, sem download completo) + download (attachment)
- ✅ Ciclo de status `draft → uploaded → processing → ready | failed` no banco
- ✅ Object storage + fila + worker reais subindo no Compose
- ✅ Migration cria a tabela `videos` ligada ao canal

## Notas de implementação
- `enqueueProcessing` retorna o `Job` (teste robusto a um worker consumidor ativo).
- `sizeBytes` mapeado como string (TypeORM `bigint`) para não perder precisão.
- Processor integration e storage integration usam MinIO/FFmpeg reais (sem mock).
- `Dockerfile.dev` recebeu `ffmpeg` para o teste do processor rodar na suíte da API.
- `jest-e2e.json` recebeu `maxWorkers:1` (e2e serial, como o CLAUDE.md exige).
- Bugfix de baseline (pré-fase, em `dev` via Git Flow): teste de migrations que travava
  (enum não dropado) + alinhamento do eslint à política documentada do CLAUDE.md.

# Phase 03 — Progress

Progresso da implementação (skill `implement`), atualizado a cada SI com status + testes.
Formato conforme `docs/phases/phase-02-auth-frontend/progress.md`.

Legenda: ⬜ pendente · 🟡 em andamento · ✅ concluído (testes verdes)

| SI | Descrição | Status | Testes |
|----|-----------|--------|--------|
| SI-03.0 | Infra & deps (MinIO, Redis, config, install) | ✅ | infra up verificada (redis/minio healthy, worker up, bucket `videos` criado); tsc 0 |
| SI-03.1 | Entidade `Video` + migration `CreateVideos` | ⬜ | — |
| SI-03.2 | Storage service (S3/MinIO) | ⬜ | — |
| SI-03.3 | Fila BullMQ + producer | ⬜ | — |
| SI-03.4 | Upload: iniciar (draft + multipart + presigned) | ⬜ | — |
| SI-03.5 | Upload: concluir (complete + enqueue) | ⬜ | — |
| SI-03.6 | Worker: ffprobe + thumbnail + container | ⬜ | — |
| SI-03.7 | Metadata + streaming (206/range) + download | ⬜ | — |
| SI-03.8 | Fechamento do módulo + DoD | ⬜ | — |

## Definition of Done (checklist final)
- ⬜ `npm test -- --runInBand` verde (unit + integração)
- ⬜ `npm run test:e2e` verde
- ⬜ `npx tsc --noEmit` código 0
- ⬜ `npm run lint` passa
- ⬜ `docker compose up -d` sobe api/db/mailpit/redis/minio/video-worker
- ⬜ `CLAUDE.md` atualizado com a seção de vídeos

## Notas de implementação
(a preencher durante `implement` — decisões de execução, ajustes, gaps encontrados)

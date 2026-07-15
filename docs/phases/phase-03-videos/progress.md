# Phase 03 — Progress

Progresso da implementação (skill `implement`), atualizado a cada SI com status + testes.
Formato conforme `docs/phases/phase-02-auth-frontend/progress.md`.

Legenda: ⬜ pendente · 🟡 em andamento · ✅ concluído (testes verdes)

| SI | Descrição | Status | Testes |
|----|-----------|--------|--------|
| SI-03.0 | Infra & deps (MinIO, Redis, config, install) | ✅ | infra up verificada (redis/minio healthy, worker up, bucket `videos` criado); tsc 0 |
| SI-03.1 | Entidade `Video` + migration `CreateVideos` | ✅ | entity integration 6 verdes; migration aplica |
| SI-03.2 | Storage service (S3/MinIO) | ✅ | integração 5 verdes contra MinIO real |
| SI-03.3 | Fila BullMQ + producer | ✅ | unit + integração (Redis real) verdes |
| SI-03.4 | Upload: iniciar (draft + multipart + presigned) | ✅ | service unit + e2e (201/401/403/400) |
| SI-03.5 | Upload: concluir (complete + enqueue) | ✅ | e2e (200/403/404/409) + enqueue |
| SI-03.6 | Worker: ffprobe + thumbnail + container | ✅ | processor integration (MP4 real→ready+thumbnail); worker container ativo |
| SI-03.7 | Metadata + streaming (206/range) + download | ✅ | e2e 8: metadata, stream 206 c/ Content-Range, sem range 200, download attachment, 404 |
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

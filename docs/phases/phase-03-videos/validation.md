# Phase 03 — Validation

Validação do contexto/decisões antes de gerar o plano (skill `plan-validate`).
Itera com `plan-resolve` até fechar **clean**. Fontes: `technical-decisions-phase-03-videos.md`
(TD-01..08), `context.md`, `library-refs.md`.

## Rodada 1 — dirty

Gaps e inconsistências encontrados:

| # | Tipo | Descrição | Resolução |
|---|---|---|---|
| V1 | Decisão faltando | Fila marcada "TBD" na arquitetura | TD-01: **BullMQ + Redis** (`@nestjs/bullmq`) |
| V2 | Decisão faltando | Estratégia de upload de 10GB não definida | TD-02: **presigned multipart** direto ao storage |
| V3 | Decisão faltando | Streaming não especificado | TD-07: **API proxy de Range → 206** + download |
| V4 | Decisão faltando | Modelo de execução do worker | TD-04: **container separado** (Nest standalone + FFmpeg) |
| V5 | Decisão faltando | Ciclo de status e falha | TD-08: `draft→uploaded→processing→ready\|failed` + retries |
| V6 | Gap de dependência | Versões das libs novas não fixadas | `library-refs.md` via context7 (OQ-1) |
| V7 | Inconsistência | `nanoid` latest (v6) é ESM-only vs. projeto CommonJS | fixar `nanoid@3.3.16` (CJS) (OQ-2/OQ-4) |
| V8 | Gap | Como o worker lê o source | `GetObjectCommand`→arquivo temp; thumbnail via `PutObject` (OQ-3) |
| V9 | Gap | Limites do multipart para 10GB | parte ≥5MiB, ≤10000 partes; cliente define tamanho (OQ-5) |
| V10 | Inconsistência de infra | Compose atual não tem storage/fila/worker | plano adiciona `minio`, `redis`, `video-worker` |

## Rodada 2 — verificação pós-resolve

- ✅ Todas as decisões em aberto do enunciado resolvidas (V1–V5) em `technical-decisions-phase-03-videos.md`.
- ✅ Gaps de dependência (V6, V7) fechados em `library-refs.md` com versões via context7.
- ✅ Gaps de comportamento (V8, V9) resolvidos e rastreáveis (OQ-3/OQ-5).
- ✅ Infra nova (V10) especificada para o Compose (minio/redis/video-worker) — detalhada no plano.
- ✅ Data model esboçado e consistente com a relação `channel 1:N videos`.
- ✅ Autorização coerente com o produto (leitura pública de vídeos `ready`; escrita = dono do canal).
- ✅ Testes: níveis definidos (unit/integração/e2e) com infra real (MinIO/Redis) — sem mock do que roda de verdade.
- ✅ Rastreabilidade: todo item do plano referencia um TD, uma OQ resolvida ou o `project-plan.md`.

Nenhum gap ou inconsistência remanescente.

## Status: **clean** ✅

Pronto para `plan-build` (gerar `phase-03-videos.md` com SIs + Technical Specifications +
Dependency Map + Deliverables).

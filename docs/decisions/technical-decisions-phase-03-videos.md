<!--
Technical decisions for Phase 03 — Upload and Video Processing.
Format follows docs/decisions/technical-decisions-phase-02-auth.md:
each decision has Scope, Capability, Context, Options (with trade-offs),
Recommendation and Decision. These decisions feed the planning pipeline
(context → validate → resolve → build).
-->

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

Escopo da fase (de `docs/project-plan.md`, Fase 03): object storage, fila de
processamento, upload de até 10GB sem travar o sistema, pré-cadastro como rascunho,
processamento automático (duração + metadados), thumbnail automático, URL única,
streaming e download.

Arquitetura-alvo (de `docs/diagrams/software-arch.mermaid`): a API publica jobs numa
**Message Queue (TBD)**; um **Video Worker (FFmpeg)** consome os jobs, lê/escreve no
**Object Storage (S3/MinIO)** e atualiza o **Database (PostgreSQL)**.

---

## TD-01: Message Queue Technology

**Scope:** Backend + Infra (a principal decisão de stack da fase — marcada "TBD" no plano)

**Capability:** "Serviço de processamento em segundo plano (filas)" + worker de vídeo

**Context:** O processamento de vídeo (ffprobe + geração de thumbnail) é pesado e não pode
bloquear a request de upload. Precisamos de uma fila persistente com retries, backoff,
concorrência controlada e um worker dedicado que a consuma num processo/container separado.
A escolha define a infra nova no Compose e a integração no NestJS.

**Options:**

### Option A: BullMQ (Redis) via `@nestjs/bullmq`
- **Prós:** integração first-class com NestJS (`@Processor`/`@Process`, `BullModule`);
  retries com backoff exponencial, rate limit, concorrência, eventos de progresso/estado
  prontos; worker roda como processo separado consumindo a mesma fila Redis; ecossistema
  maduro e amplamente documentado.
- **Contras:** adiciona um serviço novo (Redis) ao Compose; jobs vivem no Redis (memória).

### Option B: pg-boss (fila sobre o PostgreSQL existente)
- **Prós:** zero infra nova (reusa o Postgres já no stack); jobs transacionais junto do
  domínio; persistência durável em disco.
- **Contras:** sem integração NestJS oficial (wrapper manual); ergonomia de worker inferior
  à do BullMQ; concorrência/polling competindo com a carga transacional do banco.

### Option C: RabbitMQ via `@nestjs/microservices` (amqplib)
- **Prós:** broker AMQP robusto, roteamento avançado, padrão para microserviços.
- **Contras:** mais peça de infra e conceitos (exchanges/bindings) do que a fase precisa;
  `@nestjs/microservices` é orientado a RPC/mensageria, não a "job queue" com retries/backoff
  prontos; overkill para uma única fila de processamento de vídeo.

**Recommendation:** **Option A (BullMQ + Redis)** — é a escolha idiomática de job queue no
NestJS, com worker dedicado, retries/backoff e observabilidade de estado prontos, que é
exatamente o que a fase pede. O custo de adicionar Redis ao Compose é baixo e o diagrama de
arquitetura já prevê um container de fila dedicado. pg-boss seria a alternativa "sem infra
nova", mas a ergonomia de worker e o suporte NestJS pesam a favor do BullMQ.

**Decision:** A (BullMQ + Redis, via `@nestjs/bullmq`)

---

## TD-02: Large File Upload Strategy (até 10GB)

**Scope:** Backend + Frontend contract

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na
performance" + "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Passar 10GB pelo processo da API (buffer/multipart no Node) consumiria memória,
seguraria event loop/worker e é o caminho explicitamente reprovado pelo desafio. O arquivo
deve ir direto ao object storage, com a API apenas orquestrando (pré-cadastro + credenciais).

**Options:**

### Option A: Presigned **Multipart** Upload (S3/MinIO) direto do cliente
- **Prós:** o byte do vídeo nunca passa pela API; multipart permite partes grandes, paralelas
  e retomáveis, ideal para 10GB; a API só assina URLs. Escala e não bloqueia.
- **Contras:** protocolo de 3 passos (create → upload parts → complete); mais endpoints.

### Option B: Presigned **single PUT** (uma URL para o arquivo inteiro)
- **Prós:** simples (1 URL, 1 PUT direto ao storage); byte também não passa pela API.
- **Contras:** um único PUT de 10GB é frágil (sem retomada por parte; falha reinicia tudo);
  limites de tamanho por objeto em alguns gateways.

### Option C: Streaming através da API para o storage
- **Prós:** um endpoint só.
- **Contras:** a API vira gargalo/ponto de memória para 10GB — **reprovado pelo desafio**.

**Recommendation:** **Option A (Presigned Multipart)** — é a estratégia correta para 10GB:
partes paralelas e retomáveis, byte direto ao MinIO, API fora do caminho de dados. O
pré-cadastro do vídeo como `draft` acontece no passo *create* (a API cria o registro e a
sessão multipart e devolve as URLs assinadas das partes). O *complete* fecha o multipart e
enfileira o job de processamento.

**Decision:** A (Presigned Multipart Upload direto ao MinIO/S3)

---

## TD-03: Object Storage Usage (buckets & key layout)

**Scope:** Backend + Infra

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** O storage não é escolha em aberto (S3 compatível; MinIO local no Compose, S3 em
prod). O que se decide é *como usar*: organização de buckets/chaves e o cliente.

**Options:**

### Option A: Bucket único `videos` com prefixos por canal e tipo
- Chaves: `channels/{channelId}/videos/{videoId}/source/{uuid}.{ext}` e
  `.../thumbnails/{uuid}.jpg`. Cliente: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.
- **Prós:** um bucket, políticas simples; prefixos dão isolamento lógico e facilitam limpeza
  por vídeo/canal; SDK oficial funciona igual em MinIO e S3.
- **Contras:** políticas por bucket menos granulares que buckets separados.

### Option B: Buckets separados (`videos-source`, `videos-thumbnails`)
- **Prós:** políticas/lifecycle distintos (ex.: thumbnails públicos, source privado).
- **Contras:** mais provisionamento; a distinção também dá para fazer por prefixo + ACL.

**Recommendation:** **Option A** — bucket único `videos` com layout de chaves por
canal/vídeo/tipo, acessado via `@aws-sdk/client-s3`. Simples de provisionar no MinIO
(bootstrap cria o bucket no boot), portável para S3 sem mudança de código, e o prefixo por
`videoId` casa com a estratégia de URL única (TD-06) e com o cleanup em falha (TD-07).

**Decision:** A (bucket `videos`, chaves `channels/{channelId}/videos/{videoId}/{source|thumbnails}/...`)

---

## TD-04: Worker Execution Model

**Scope:** Backend + Infra

**Capability:** worker de vídeo que consome a fila e processa

**Context:** O worker é CPU-bound (FFmpeg) e precisa de FFmpeg instalado. Rodá-lo no mesmo
processo da API competiria por CPU e event loop.

**Options:**

### Option A: Container separado rodando um Nest **standalone worker** (mesmo código, entrypoint próprio)
- **Prós:** reusa entidades/DTOs/config/DataSource do projeto (um só codebase); escala e
  reinicia independente da API; imagem com FFmpeg isolada do runtime da API; consome a fila
  BullMQ via `@Processor`.
- **Contras:** um serviço a mais no Compose; precisa de um entrypoint de bootstrap do worker.

### Option B: Worker no mesmo processo da API (processor registrado no AppModule)
- **Prós:** zero container novo.
- **Contras:** FFmpeg concorre com a API pela CPU; um vídeo pesado degrada as requests;
  contraria o diagrama (worker é um container à parte).

**Recommendation:** **Option A** — container `video-worker` separado, buildado do mesmo
projeto NestJS com FFmpeg instalado na imagem, subindo um contexto standalone que registra o
`@Processor` da fila de vídeo. Mantém a API responsiva e reflete a arquitetura-alvo.

**Decision:** A (container `video-worker` separado, Nest standalone, FFmpeg na imagem)

---

## TD-05: Metadata Extraction & Thumbnail Generation

**Scope:** Backend (worker)

**Capability:** "Processamento automático (extração de duração e metadados)" + "Geração
automática de thumbnail a partir de um frame do vídeo"

**Context:** Após o upload, o worker precisa ler duração/metadados e extrair um frame como
thumbnail. FFmpeg é dado pelo diagrama.

**Options:**

### Option A: `ffprobe` (metadados) + `ffmpeg` (thumbnail) via `child_process` (binários na imagem)
- **Prós:** controle total dos flags, sem camada extra; `ffprobe -show_format -show_streams`
  dá duração/resolução/codec; `ffmpeg -ss <t> -frames:v 1` extrai o frame; determinístico.
- **Contras:** montar/parsear comandos manualmente.

### Option B: `fluent-ffmpeg` (wrapper Node)
- **Prós:** API fluente para montar comandos e `ffprobe()` com callback parseado.
- **Contras:** dependência menos mantida; ainda exige os binários; abstração fina sobre o que
  já é simples.

**Recommendation:** **Option A** — chamar `ffprobe`/`ffmpeg` diretamente via `child_process`
com os binários instalados na imagem do worker. Menos superfície de dependência, flags
explícitos e fáceis de testar de verdade (o worker roda ffmpeg real no Compose). O worker
baixa o source do storage (ou usa presigned GET), roda ffprobe/ffmpeg, sobe o thumbnail e
atualiza o vídeo no banco.

**Decision:** A (ffprobe + ffmpeg via child_process, binários na imagem do worker)

---

## TD-06: Unique Video URL Strategy

**Scope:** Backend (Data Model + API)

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Cada vídeo precisa de um identificador público estável para URL/streaming, sem
expor o `id` sequencial/PK e sem colisão.

**Options:**

### Option A: `publicId` curto com `nanoid` (coluna única, ex.: 12 chars url-safe)
- **Prós:** curto, url-safe, colisão desprezível; desacopla a URL pública da PK interna;
  gerado na criação do rascunho.
- **Contras:** dependência extra (`nanoid`).

### Option B: UUID v4
- **Prós:** nativo (`crypto.randomUUID`), sem dependência, único.
- **Contras:** longo (36 chars) e feio em URL; expõe formato de UUID.

**Recommendation:** **Option A (`nanoid`)** — id público curto e amigável para a URL única do
vídeo, com coluna `UNIQUE` no banco. Gerado no pré-cadastro (draft). UUID v4 é o fallback sem
dependência, mas o `publicId` curto é melhor para URLs de vídeo.

**Decision:** A (`publicId` via `nanoid`, coluna UNIQUE)

---

## TD-07: Streaming & Download Strategy

**Scope:** Backend (API)

**Capability:** "Reprodução via streaming (sem download completo)" + "Download do vídeo"

**Context:** Players precisam de acesso parcial por range (seek) sem baixar o arquivo inteiro.
Duas formas de servir: a API faz proxy do range a partir do storage (206) ou emite URL
pré-assinada e o cliente vai direto ao storage.

**Options:**

### Option A: API faz proxy de **HTTP Range** (`206 Partial Content`) lendo do storage
- **Prós:** um endpoint estável por `publicId`; suporta `Range`/`206` (seek) e resposta
  `200` completa; a API controla acesso/status (só serve vídeo `ready`); testável de ponta a
  ponta com supertest + MinIO real. Download é o mesmo stream com `Content-Disposition: attachment`.
- **Contras:** o byte passa pela API na leitura (mitigado: streaming por range, não buffer;
  o S3 SDK suporta `Range` no `GetObject`, então só o range pedido trafega).

### Option B: Redirect para **presigned GET** (cliente vai direto ao storage)
- **Prós:** byte não passa pela API; storage serve range nativamente.
- **Contras:** URL pré-assinada expira e vaza a localização do storage; controle de acesso
  por-request mais difícil; teste e2e depende de acessar o MinIO direto.

**Recommendation:** **Option A** — endpoint de streaming por `publicId` que repassa o header
`Range` ao `GetObject` do storage e devolve `206 Partial Content` (ou `200` sem range),
servindo apenas o range pedido (sem bufferizar o arquivo). O mesmo mecanismo serve o
**download** com `Content-Disposition: attachment`. Simetria com o controle de status e
testabilidade real no Compose pesam a favor. (Presigned GET fica como otimização de produção.)

**Decision:** A (API proxy de Range → 206; download via `Content-Disposition: attachment`)

---

## TD-08: Video Status Lifecycle & Failure Handling

**Scope:** Backend (Data Model + worker)

**Capability:** ciclo de status do vídeo e comportamento em falha de processamento

**Context:** O vídeo passa por estados do rascunho ao pronto. Precisamos de um ciclo explícito
no banco e de comportamento definido quando o FFmpeg/worker falha.

**Options:**

### Option A: `draft → uploaded → processing → ready | failed`
- `draft`: pré-cadastro ao iniciar upload (multipart aberto). `uploaded`: multipart concluído
  (job enfileirado). `processing`: worker pegou o job. `ready`: metadados + thumbnail ok.
  `failed`: erro no processamento (guarda motivo). Retries do BullMQ (ex.: 3, backoff) antes de
  marcar `failed`. Só `ready` é streamable/baixável.
- **Prós:** estados observáveis e alinhados ao fluxo real; falha isolada não quebra o sistema.

### Option B: `draft → processing → ready | error` (sem `uploaded`)
- **Prós:** menos estados.
- **Contras:** perde a distinção entre "upload concluído" e "worker começou", útil para
  diagnosticar onde travou.

**Recommendation:** **Option A** — ciclo `draft → uploaded → processing → ready | failed`.
O BullMQ tenta reprocessar (backoff); esgotadas as tentativas, o vídeo vai a `failed` com
`failureReason`. Endpoints de streaming/download só respondem para `ready` (senão `409/404`).

**Decision:** A (draft → uploaded → processing → ready | failed; retries no worker antes de failed)

---

## Resumo das decisões

| ID | Decisão |
|----|---------|
| TD-01 | Fila: **BullMQ + Redis** (`@nestjs/bullmq`) |
| TD-02 | Upload 10GB: **presigned multipart** direto ao storage |
| TD-03 | Storage: bucket `videos`, chaves por `channel/video/{source,thumbnails}` (`@aws-sdk/client-s3`) |
| TD-04 | Worker: **container separado** (Nest standalone) com FFmpeg |
| TD-05 | Processamento: **ffprobe + ffmpeg** via child_process |
| TD-06 | URL única: **`publicId` (nanoid)**, coluna UNIQUE |
| TD-07 | Streaming: **API proxy de Range → 206**; download com `Content-Disposition` |
| TD-08 | Status: **draft → uploaded → processing → ready \| failed** com retries |

As versões exatas das libs novas (`@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`,
`@aws-sdk/s3-request-presigner`, `nanoid`) são fixadas via context7 na etapa plan-resolve
(`docs/phases/phase-03-videos/library-refs.md`).

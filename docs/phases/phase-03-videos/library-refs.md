# library-refs.md — Fase 03 (libs novas fixadas)

Referências de biblioteca fixadas para a Fase 03 (skill `plan-resolve`). Consultadas via
**context7** (MCP) contra as versões-alvo. NestJS 11, TypeScript, **CommonJS**.

Instalar (dentro do container): `docker compose exec nestjs-api npm i @nestjs/bullmq bullmq @aws-sdk/client-s3 @aws-sdk/s3-request-presigner nanoid@3`

| Lib | Versão fixada | Papel | Nota |
|---|---|---|---|
| `@nestjs/bullmq` | `11.0.4` | integração NestJS da fila | peer alinhado ao Nest core 11.x |
| `bullmq` | `5.80.4` | engine da fila (tipos `Queue`/`Job`) | BullMQ 5.x |
| `@aws-sdk/client-s3` | `3.1087.0` | cliente S3/MinIO (commands) | AWS SDK v3 |
| `@aws-sdk/s3-request-presigner` | `3.1087.0` | URLs pré-assinadas | par do client-s3 |
| `ioredis` | `5.11.1` | conexão Redis (peer do BullMQ) | via `connection {host,port}` |
| `nanoid` | **`3.3.16`** | `publicId` do vídeo | **v4+ é ESM-only → fixar v3 (CJS)** |

FFmpeg/`ffprobe`: **binários na imagem do worker** (apt), não pacote npm.

---

## 1. Fila — `@nestjs/bullmq` 11.0.4 + `bullmq` 5.80.4

### Imports
```typescript
import { BullModule, InjectQueue, Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
```

### Registro (API v11 — atenção às mudanças vs. `@nestjs/bull` v3)
```typescript
// raiz (async, lendo config): a chave é `connection` (NÃO `redis`)
BullModule.forRootAsync({
  inject: [redisConfig.KEY],
  useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
});
// no módulo da feature:
BullModule.registerQueue({ name: 'video-processing' });
```

### Producer
```typescript
constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
// add(jobName, data, opts) — 3 args (BullMQ 5). retries + backoff exponencial:
await this.queue.add('process-video', { videoId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
});
```

### Consumer (WorkerHost — `@Process` NÃO existe no BullMQ)
```typescript
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // ... ffprobe + thumbnail + update
  }
  @OnWorkerEvent('failed') onFailed(job: Job, err: Error) { /* marca failed após esgotar attempts */ }
}
```

### Worker standalone (container separado)
```typescript
// src/videos/worker/main.ts — sem HTTP; o @Processor consome ao iniciar o contexto
const app = await NestFactory.createApplicationContext(VideoWorkerModule);
app.enableShutdownHooks();       // fecha Worker/Redis limpo; NÃO chamar app.close()
```
`VideoWorkerModule` importa `BullModule.forRoot(...)` + `registerQueue({ name: 'video-processing' })`,
TypeORM (mesmo DataSource) e o storage, e declara `VideoProcessor` como provider.

### Armadilhas (confirmadas via context7)
- Opção de conexão é `connection`, não `redis`. `add()` tem 3 args. `@Process` é do Bull v3 antigo.
- DI **não** funciona em sandboxed processors (`processors: [path]`); usar `WorkerHost` + standalone.
- BullMQ ≥2 não precisa de `QueueScheduler`.

---

## 2. Storage — `@aws-sdk/client-s3` 3.1087.0 + `s3-request-presigner` 3.1087.0

### Imports
```typescript
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  GetObjectCommand, HeadBucketCommand, CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
```

### Client MinIO (path-style)
```typescript
new S3Client({
  region: 'us-east-1',                    // obrigatório mesmo no MinIO
  endpoint: 'http://minio:9000',          // service name do Compose (NÃO localhost)
  forcePathStyle: true,                   // essencial no MinIO
  credentials: { accessKeyId, secretAccessKey },
});
```

### Bootstrap do bucket
```typescript
try { await s3.send(new HeadBucketCommand({ Bucket })); }
catch (err) { if (err?.$metadata?.httpStatusCode === 404) await s3.send(new CreateBucketCommand({ Bucket })); else throw err; }
```

### Multipart presigned (upload de 10GB direto do cliente)
```typescript
// 1. iniciar → UploadId
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));
// 2. URL assinada por parte (cliente faz PUT e lê o ETag da resposta)
const url = await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });
// 3. completar (parts em ordem crescente com ETag)
await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ ETag, PartNumber }, ...] } }));
// 4. abortar (cleanup em falha/cancelamento)
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

### GetObject com Range (streaming parcial → 206)
```typescript
const r = await s3.send(new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-1048575' }));
const stream = r.Body as import('stream').Readable;  // pipe direto na resposta Express
// headers para 206: r.ContentRange ("bytes 0-1048575/N"), r.ContentLength, r.ContentType
```
- `r.Body` é `Readable` (Node): **pipe** direto para streaming; não usar `transformToString` (bufferiza).
- Sem `Range` → 200 com objeto inteiro; com `Range` válido → 206 + `ContentRange`.

### Armadilhas (confirmadas via context7)
- AWS SDK v3 command pattern (`client.send(command)`) — API atual, **sem deprecated** no escopo.
- MinIO exige `forcePathStyle: true` e `region`; expor `ETag` no CORS para o PUT de parte no browser.
- Preferir `S3Client` + commands (tree-shakeable, CJS ok) ao cliente agregado `new S3()`.

---

## 3. `nanoid` 3.3.16 (publicId)
```typescript
import { nanoid } from 'nanoid';   // v3 é CommonJS (v4+ é ESM-only → não usar no projeto CJS)
const publicId = nanoid(12);       // url-safe, colisão desprezível
```

## 4. FFmpeg / ffprobe (worker)
Binários instalados na imagem do worker (`apt install -y ffmpeg`), chamados via
`child_process`:
- **Metadados/duração:** `ffprobe -v quiet -print_format json -show_format -show_streams <input>`
  → JSON com `format.duration`, `streams[].width/height/codec_name`.
- **Thumbnail:** `ffmpeg -ss <seg> -i <input> -frames:v 1 -q:v 2 <out.jpg>` (1 frame).
Não há pacote npm fixado para FFmpeg (decisão TD-05: child_process direto).

---

## Resolução das Open Questions (do context.md)
- **OQ-1** (versões): fixadas na tabela acima via context7. ✅
- **OQ-2/OQ-4** (nanoid ESM): resolvido — fixar `nanoid@3.3.16` (CJS). ✅
- **OQ-3** (worker acessa source): via `GetObjectCommand` (stream) para arquivo temporário no
  worker; ffprobe/ffmpeg leem o arquivo local; thumbnail sobe via `PutObject`. ✅
- **OQ-5** (partes multipart): parte mínima 5MiB (limite S3, exceto última); até 10000 partes;
  cliente define o tamanho da parte (ex.: 64–256MiB) — 10GB cabe folgado. ✅

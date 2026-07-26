# FiapX.Processor

Serviço responsável por processar vídeos enviados pelos usuários no ecossistema FIAP X.

Consome a fila SQS `fiapx-{env}-video-processing-requested`, extrai frames do vídeo com FFmpeg, compacta o resultado em ZIP, armazena no S3 e publica o evento de conclusão.

## Definição do ambiente

- Runtime: Bun + TypeScript
- Framework: Elysia
- Mensageria: Amazon SQS
- Armazenamento: Amazon S3
- Banco de dados: Amazon DynamoDB

```mermaid
graph TD
    Q[SQS: video-processing-requested] -->|consumido por| W[ProcessorWorker\nScaledJob]
    W -->|lê vídeo| S3in[S3: videos/]
    W -->|grava frames + zip| S3out[S3: frames/]
    W -->|atualiza status| DB[DynamoDB: videos-db]
    W -->|publica| Q2[SQS: video-processing-completed]
```

## Pré-requisitos

Para rodar localmente, é necessário ter o Docker em execução. O `docker-compose.yml` sobe o LocalStack com SQS, S3 e DynamoDB.

```bash
docker compose up -d
```

Copie o arquivo de variáveis de ambiente e ajuste conforme necessário:

```bash
cp .env.example .env
```

## Como executar localmente

```bash
bun install
bun run worker
```

## Script de deploy

Execute o script PowerShell para compilar a imagem e publicar no ECR.

```powershell
.\scripts\deploy-image.ps1 dev
```

Para publicar uma mensagem de teste na fila local:

```powershell
.\scripts\send-message.ps1
```

## Mensageria

### Consumers

| Fila | Descrição |
|------|-----------|
| `fiapx-{env}-video-processing-requested` | Dispara o processamento de um vídeo enviado pelo usuário. |

### Publishers

| Fila | Descrição |
|------|-----------|
| `fiapx-{env}-video-processing-completed` | Notifica sobre o resultado do processamento (sucesso ou falha). |

## Observabilidade

O serviço exporta traces, métricas e logs via OpenTelemetry direto para o intake OTLP do Datadog, sem Agent nem Collector. A integração fica em `src/shared/observability/` e aparece no Datadog como `fiapx-processor`.

- **Traces**: span de consumo `{fila} process` continuando o trace da API (header `traceparent` do envelope), spans das fases de processamento (`video.download`, `video.extract_frames`, `video.zip_upload`), spans `CLIENT` por chamada AWS e span de publicação `{fila} publish`. Toda span de negócio carrega a tag `video.id`.
- **Métricas**: `videos.processed` (tag `status`), `videos.processing_duration_seconds` (tag `status`) e `videos.frames_extracted`.
- **Logs**: correlacionados automaticamente ao trace (TraceId/SpanId) e também escritos no stdout.

A API key não é versionada. Localmente a observabilidade fica desligada por padrão e a aplicação registra `Datadog observability disabled` na inicialização. No cluster a key chega pela secret `observability/datadog-api-key`, espelhada para o namespace do serviço pelo Reflector e lida da env `DD_API_KEY`; se a secret não existir, o serviço sobe normalmente com a observabilidade desligada.

Por rodar como KEDA ScaledJob (processo de vida curta), o worker executa flush explícito dos três providers no encerramento — sem isso a telemetria do job inteiro se perde.

Duas diferenças em relação aos serviços .NET, por limitação do runtime:

- sem métricas de runtime (GC/thread pool), que o Bun não expõe de forma equivalente;
- sem instrumentação HTTP de servidor no `src/index.ts`, que é um stub de desenvolvimento (o container roda `bun run worker`).

Para um teste pontual contra o Datadog:

```powershell
$env:DD_API_KEY = "<valor da key>"
bun run worker
```

Arquitetura, configuração e troubleshooting: [Observabilidade](https://github.com/13soat-fiapx/fiapx-docs/blob/main/docs/observability.md).

## Links úteis

- [fiapx-infra](https://github.com/13soat-fiapx/fiapx-infra)
- [fiapx-notifier](https://github.com/13soat-fiapx/fiapx-notifier)
- [fiapx-web](https://github.com/13soat-fiapx/fiapx-web)

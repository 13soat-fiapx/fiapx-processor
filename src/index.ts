import { openapi } from '@elysia/openapi';
import { Elysia } from "elysia";
import { broker } from './modules/broker';
import { processingJobs } from './modules/processing-jobs';
import { initObservability, shutdownObservability } from './shared/observability';
import { logger } from './shared/observability/logger';

// Traces and metrics emitted by the broker/processor modules still flow; the HTTP surface
// itself is not instrumented because this entrypoint is a development stub (the container
// runs `bun run worker`).
initObservability();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdownObservability().finally(() => process.exit(0));
  });
}

const app = new Elysia()
  .use(openapi({
    path: '/openapi',
    specPath: '/openapi/json',
    embedSpec: true,
    documentation: {
      info: {
        title: 'FIAP X Video Processor API',
        description: 'API for video processing events',
        version: '1.0.50',
      },
    },
  }))
  .get("/", () => "Hello Elysia")
  .use(broker)
  .use(processingJobs)
  .listen(3000);

logger.info(
  { hostname: app.server?.hostname, port: app.server?.port },
  "Elysia server started",
);

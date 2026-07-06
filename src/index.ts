import { openapi } from '@elysia/openapi';
import { Elysia } from "elysia";
import { broker } from './modules/broker';
import { processingJobs } from './modules/processing-jobs';

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

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

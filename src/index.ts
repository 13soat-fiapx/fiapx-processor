import { openapi } from '@elysia/openapi';
import { Elysia } from "elysia";
import { broker } from './modules/broker';

const app = new Elysia()
  .use(openapi())
  .get("/", () => "Hello Elysia")
  .use(broker)
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

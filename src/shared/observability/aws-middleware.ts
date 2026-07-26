import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { config } from "../../config";
import { getTracer } from "./telemetry";

/**
 * Structural view of an AWS SDK v3 client. The concrete clients (S3, SQS, STS, DynamoDB) have
 * incompatible generic signatures, so only the parts this middleware touches are typed.
 */
type MiddlewareContext = { clientName?: string; commandName?: string };
type NextHandler = (args: unknown) => Promise<unknown>;

export type InstrumentableClient = {
  middlewareStack: {
    add: (
      middleware: (next: NextHandler, context: MiddlewareContext) => NextHandler,
      options: { step: "initialize"; name: string; override: boolean },
    ) => void;
  };
};

/** "SQSClient" -> "SQS", "DynamoDBClient" -> "DynamoDB" */
export function toServiceName(clientName?: string) {
  return clientName?.replace(/Client$/, "") || "AWS";
}

/** "ReceiveMessageCommand" -> "ReceiveMessage" */
export function toOperationName(commandName?: string) {
  return commandName?.replace(/Command$/, "") || "UnknownOperation";
}

/**
 * Replaces the HttpClient instrumentation used by the .NET services: it covers every SQS, S3,
 * DynamoDB and STS call without monkey-patching, which is what makes it viable under Bun.
 */
export function instrumentAwsClient<T extends InstrumentableClient>(client: T): T {
  client.middlewareStack.add(
    (next, middlewareContext) => async (args) => {
      const service = toServiceName(middlewareContext.clientName);
      const operation = toOperationName(middlewareContext.commandName);

      const span = getTracer().startSpan(`${service} ${operation}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          "rpc.system": "aws-api",
          "rpc.service": service,
          "rpc.method": operation,
          "aws.region": config.awsRegion,
        },
      });

      try {
        return await next(args);
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
    { step: "initialize", name: "fiapxObservabilityMiddleware", override: true },
  );

  return client;
}

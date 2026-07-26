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

/**
 * What the generic constrains on. The concrete clients declare `add` as a set of overloads that
 * is not assignable to the simplified signature above, so constraining directly on
 * `InstrumentableClient` rejects every real client and collapses the return type to the
 * constraint — which is why `s3Client.send` used to be reported as missing.
 */
type HasMiddlewareStack = { middlewareStack: { add: (...args: never[]) => void } };

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
export function instrumentAwsClient<T extends HasMiddlewareStack>(client: T): T {
  (client as unknown as InstrumentableClient).middlewareStack.add(
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

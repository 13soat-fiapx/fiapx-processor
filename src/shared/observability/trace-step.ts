import type { Attributes } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "./telemetry";

/**
 * Wraps one processing phase in an active span. Errors are recorded and rethrown so the
 * caller's retry/DLQ behaviour is untouched.
 */
export function traceStep<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
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
  });
}

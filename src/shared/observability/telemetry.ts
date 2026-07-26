import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

/**
 * Fixed instrumentation scope name shared by every FiapX service. Service identity comes from
 * the resource (`service.name`), never from the tracer/meter name.
 */
export const TELEMETRY_SOURCE_NAME = "FiapX";

/** Service name prefix. `service.name` is composed as `fiapx-{APP_NAME}`. */
export const SERVICE_PREFIX = "fiapx-";

/**
 * The three signal handles are resolved lazily from the global API: without a registered SDK
 * they are no-ops, which is exactly the behaviour the guard relies on.
 */
export function getTracer() {
  return trace.getTracer(TELEMETRY_SOURCE_NAME);
}

export function getMeter() {
  return metrics.getMeter(TELEMETRY_SOURCE_NAME);
}

export function getOtelLogger() {
  return logs.getLogger(TELEMETRY_SOURCE_NAME);
}

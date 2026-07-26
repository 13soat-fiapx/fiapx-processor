import type { LogAttributes } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { getOtelLogger } from "./telemetry";

export type LogContext = Record<string, unknown>;

const SEVERITIES = {
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
} as const;

type Level = keyof typeof SEVERITIES;

/**
 * Flattens the context into OTLP-compatible attribute values. `Error` instances are unwrapped
 * so the message survives the trip; anything else non-primitive is stringified.
 */
function toLogAttributes(logContext: LogContext): LogAttributes {
  const attributes: LogAttributes = {};

  for (const [key, value] of Object.entries(logContext)) {
    if (value === undefined || value === null) continue;

    if (value instanceof Error) {
      attributes[key] = value.message;
      attributes[`${key}.type`] = value.name;
      continue;
    }

    attributes[key] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }

  return attributes;
}

function emit(level: Level, logContext: LogContext, message: string) {
  // console must be referenced inside the call so test spies installed later still intercept.
  if (level === "info") {
    console.log(logContext, message);
  } else {
    console.error(logContext, message);
  }

  const severity = SEVERITIES[level];

  // No-op unless a LoggerProvider is registered. TraceId/SpanId come from the active context.
  getOtelLogger().emit({
    severityNumber: severity.number,
    severityText: severity.text,
    body: message,
    attributes: toLogAttributes(logContext),
  });
}

export const logger = {
  info(logContext: LogContext, message: string) {
    emit("info", logContext, message);
  },
  warn(logContext: LogContext, message: string) {
    emit("warn", logContext, message);
  },
  error(logContext: LogContext, message: string) {
    emit("error", logContext, message);
  },
};

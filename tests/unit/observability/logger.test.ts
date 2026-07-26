import { SeverityNumber } from "@opentelemetry/api-logs";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../../../src/shared/observability/logger";
import {
  startConsumerSpan,
  withSpan,
} from "../../../src/shared/observability/message-tracing";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";

let telemetry: InMemoryTelemetry;
let logSpy: ReturnType<typeof spyOn<Console, "log">>;
let errorSpy: ReturnType<typeof spyOn<Console, "error">>;

beforeEach(() => {
  telemetry = setupInMemoryTelemetry();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await telemetry.dispose();
  mock.restore();
});

describe("logger console output", () => {
  test("keeps the object-first console format on info", () => {
    logger.info({ messageId: "m-1" }, "processing SQS message");

    expect(logSpy).toHaveBeenCalledWith({ messageId: "m-1" }, "processing SQS message");
  });

  test.each([
    ["warn", () => logger.warn({ a: 1 }, "warned")],
    ["error", () => logger.error({ a: 1 }, "failed")],
  ])("writes %s to console.error", (_level, emit) => {
    emit();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("logger OTLP records", () => {
  test.each([
    ["info", SeverityNumber.INFO, "INFO"],
    ["warn", SeverityNumber.WARN, "WARN"],
    ["error", SeverityNumber.ERROR, "ERROR"],
  ])("emits a %s log record", (level, severityNumber, severityText) => {
    logger[level as "info" | "warn" | "error"]({ messageId: "m-1" }, "a message");

    const [record] = telemetry.logRecords();

    expect(record?.body).toBe("a message");
    expect(record?.severityNumber).toBe(severityNumber);
    expect(record?.severityText).toBe(severityText);
    expect(record?.attributes).toEqual({ messageId: "m-1" });
  });

  test("correlates the record with the active span", () => {
    const span = startConsumerSpan("queue", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");

    withSpan(span, () => logger.info({}, "inside the span"));
    span.end();

    const [record] = telemetry.logRecords();

    expect(record?.spanContext?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(record?.spanContext?.spanId).toBe(span.spanContext().spanId);
  });

  test("unwraps Error values and stringifies objects", () => {
    logger.error(
      { error: new TypeError("ffmpeg failed"), headers: { a: 1 }, skipped: undefined },
      "worker failed",
    );

    const [record] = telemetry.logRecords();

    expect(record?.attributes).toEqual({
      error: "ffmpeg failed",
      "error.type": "TypeError",
      headers: '{"a":1}',
    });
  });
});

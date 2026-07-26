import { SpanKind } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  currentTraceparent,
  startConsumerSpan,
  startProducerSpan,
  withSpan,
} from "../../../src/shared/observability/message-tracing";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";

const PARENT_TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
const QUEUE = "fiapx-dev-video-processing-requested";

let telemetry: InMemoryTelemetry;

beforeEach(() => {
  telemetry = setupInMemoryTelemetry();
});

afterEach(async () => {
  await telemetry.dispose();
});

describe("startProducerSpan", () => {
  test("names the span after the queue and tags the messaging attributes", () => {
    startProducerSpan(QUEUE).end();

    const span = telemetry.spanNamed(`${QUEUE} publish`);

    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.attributes["messaging.system"]).toBe("aws_sqs");
    expect(span?.attributes["messaging.destination.name"]).toBe(QUEUE);
  });
});

describe("startConsumerSpan", () => {
  test("continues the incoming trace when the traceparent is valid", () => {
    startConsumerSpan(QUEUE, PARENT_TRACEPARENT).end();

    const span = telemetry.spanNamed(`${QUEUE} process`);

    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.spanContext().traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(span?.parentSpanContext?.spanId).toBe("bbbbbbbbbbbbbbbb");
    expect(span?.attributes["messaging.system"]).toBe("aws_sqs");
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["malformed", "not-a-traceparent"],
    ["all-zero trace id", "00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01"],
    ["truncated", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ])("starts a root span without throwing when the traceparent is %s", (_label, traceparent) => {
    expect(() => startConsumerSpan(QUEUE, traceparent).end()).not.toThrow();

    const span = telemetry.spanNamed(`${QUEUE} process`);

    expect(span).toBeDefined();
    expect(span?.parentSpanContext).toBeUndefined();
  });
});

describe("currentTraceparent", () => {
  test("returns the active span as a W3C traceparent", () => {
    const span = startConsumerSpan(QUEUE, PARENT_TRACEPARENT);

    const traceparent = withSpan(span, () => currentTraceparent());
    span.end();

    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(traceparent).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(traceparent).toContain(span.spanContext().spanId);
  });

  test("returns undefined when no span is active", () => {
    expect(currentTraceparent()).toBeUndefined();
  });
});

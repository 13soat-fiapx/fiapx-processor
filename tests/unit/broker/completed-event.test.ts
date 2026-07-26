import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildVideoProcessingCompletedEvent } from "../../../src/modules/broker/service";
import type { EventHeaders } from "../../../src/modules/broker/types";
import {
  startConsumerSpan,
  withSpan,
} from "../../../src/shared/observability/message-tracing";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";
import { mockProcessingJob } from "../../mocks/worker";

const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const INCOMING_TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

const sourceHeaders: EventHeaders = {
  eventId: "event-123",
  traceparent: INCOMING_TRACEPARENT,
  tracestate: "vendor=value",
  baggage: "tenant=fiap-x",
};

const payload = {
  processingJobId: mockProcessingJob.id,
  user: {
    id: mockProcessingJob.userId,
    name: mockProcessingJob.userName,
    email: mockProcessingJob.userEmail,
  },
  status: "succeeded" as const,
  messages: [],
  completedAt: "2026-07-25T12:10:00.000Z",
};

describe("buildVideoProcessingCompletedEvent with observability enabled", () => {
  let telemetry: InMemoryTelemetry;

  beforeEach(() => {
    telemetry = setupInMemoryTelemetry();
  });

  afterEach(async () => {
    await telemetry.dispose();
  });

  test("injects the active span, staying in the incoming trace", () => {
    const span = startConsumerSpan("queue", INCOMING_TRACEPARENT);

    const event = withSpan(span, () => buildVideoProcessingCompletedEvent(payload, sourceHeaders));
    span.end();

    expect(event.headers.traceparent).toMatch(TRACEPARENT_PATTERN);
    // Same trace as the API, but the processor's own span as parent for the notifier.
    expect(event.headers.traceparent).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(event.headers.traceparent).toContain(span.spanContext().spanId);
    expect(event.headers.traceparent).not.toBe(INCOMING_TRACEPARENT);
  });
});

// No SDK is registered in this block, which is also what the guard produces when DD_API_KEY is
// absent: `propagation.inject` writes nothing and the copy fallback has to carry the envelope.
describe("buildVideoProcessingCompletedEvent without an active span", () => {
  test("copies the incoming traceparent when no SDK is registered", () => {
    const event = buildVideoProcessingCompletedEvent(payload, sourceHeaders);

    expect(event.headers.traceparent).toBe(INCOMING_TRACEPARENT);
  });

  test("generates a traceparent when there is neither a span nor an incoming header", () => {
    const event = buildVideoProcessingCompletedEvent(payload);

    expect(event.headers.traceparent).toMatch(TRACEPARENT_PATTERN);
    expect(event.headers.traceparent).not.toBe(INCOMING_TRACEPARENT);
  });
});

describe("buildVideoProcessingCompletedEvent envelope", () => {
  let telemetry: InMemoryTelemetry;

  beforeEach(() => {
    telemetry = setupInMemoryTelemetry();
  });

  afterEach(async () => {
    await telemetry.dispose();
  });

  test.each([
    ["with an active span", true],
    ["without an active span", false],
  ])("always carries a traceparent %s", (_label, useSpan) => {
    const build = () => buildVideoProcessingCompletedEvent(payload);
    const event = useSpan
      ? (() => {
          const span = startConsumerSpan("queue", INCOMING_TRACEPARENT);
          const built = withSpan(span, build);
          span.end();
          return built;
        })()
      : build();

    expect(event.headers.traceparent).toMatch(TRACEPARENT_PATTERN);
  });

  test("propagates tracestate and baggage and identifies the processor as the source", () => {
    const event = buildVideoProcessingCompletedEvent(payload, sourceHeaders);

    expect(event.headers.tracestate).toBe("vendor=value");
    expect(event.headers.baggage).toBe("tenant=fiap-x");
    expect(event.headers.eventType).toBe("video.processing.completed");
    expect(event.headers.source).toBe("fiapx-processor");
    expect(event.payload).toBe(payload);
  });
});

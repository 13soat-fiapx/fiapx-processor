import { GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SpanKind } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Broker } from "../../../src/modules/broker/service";
import type { EventHeaders } from "../../../src/modules/broker/types";
import { sqsClient } from "../../../src/shared/aws";
import {
  startConsumerSpan,
  withSpan,
} from "../../../src/shared/observability/message-tracing";
import { resetQueueUrlCache } from "../../../src/shared/utils/queue-url-resolver";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";
import { mockProcessingJob } from "../../mocks/worker";

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/completed";
const INCOMING_TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
const REQUESTED_QUEUE_NAME = "fiapx-dev-video-processing-requested";
const COMPLETED_QUEUE_NAME = "fiapx-dev-video-processing-completed";

const sourceHeaders: EventHeaders = {
  eventId: "event-123",
  traceparent: INCOMING_TRACEPARENT,
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

let telemetry: InMemoryTelemetry;
let send: ReturnType<typeof spyOn<typeof sqsClient, "send">>;

/** Reads the envelope out of the SendMessageCommand handed to the SQS client. */
function sentEnvelope() {
  const command = send.mock.calls
    .map(([call]) => call)
    .find((call): call is SendMessageCommand => call instanceof SendMessageCommand);

  return JSON.parse(String(command?.input.MessageBody));
}

beforeEach(() => {
  process.env.SQS_QUEUE_NAMES_VIDEO_PROCESSING_REQUESTED = REQUESTED_QUEUE_NAME;
  process.env.SQS_QUEUE_NAMES_VIDEO_PROCESSING_COMPLETED = COMPLETED_QUEUE_NAME;

  // Same module-global memo as in consumer.test.ts: clear it so neither file depends on which
  // one Bun happens to load first.
  resetQueueUrlCache();

  telemetry = setupInMemoryTelemetry();
  spyOn(console, "log").mockImplementation(() => {});

  send = spyOn(sqsClient, "send").mockImplementation((async (command: unknown) => {
    if (command instanceof GetQueueUrlCommand) return { QueueUrl: QUEUE_URL };
    return {};
  }) as typeof sqsClient.send);
});

afterEach(async () => {
  delete process.env.SQS_QUEUE_NAMES_VIDEO_PROCESSING_REQUESTED;
  delete process.env.SQS_QUEUE_NAMES_VIDEO_PROCESSING_COMPLETED;

  await telemetry.dispose();
  mock.restore();
});

describe("Broker.sendFrame", () => {
  const request = {
    processingJobId: "job-123",
    userId: "user-456",
    inputFile: { key: "videos/job-123/original.mp4" },
  };

  test("publishes the requested envelope with a generated traceparent", async () => {
    await Broker.sendFrame(request);

    const envelope = sentEnvelope();

    expect(envelope.headers.eventType).toBe("video.processing.requested");
    expect(envelope.headers.source).toBe("fiapx-video-processor");
    expect(envelope.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(envelope.payload.processingJobId).toBe("job-123");
    expect(envelope.payload.requestedAt).toBeString();
  });

  test("opens a producer span tagged with video.id", async () => {
    await Broker.sendFrame(request);

    const span = telemetry.spanNamed(`${REQUESTED_QUEUE_NAME} publish`);

    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.attributes["video.id"]).toBe("job-123");
    expect(span?.attributes["messaging.destination.name"]).toBe(REQUESTED_QUEUE_NAME);
    expect(span?.ended).toBe(true);
  });

  test("ends the span and rethrows when publishing fails", async () => {
    send.mockImplementation((async (command: unknown) => {
      if (command instanceof GetQueueUrlCommand) return { QueueUrl: QUEUE_URL };
      throw new Error("publish failed");
    }) as typeof sqsClient.send);

    await expect(Broker.sendFrame(request)).rejects.toThrow("publish failed");

    expect(telemetry.spanNamed(`${REQUESTED_QUEUE_NAME} publish`)?.ended).toBe(true);
  });
});

describe("Broker.sendProcessingCompleted", () => {
  test("publishes the completion envelope to the completed queue", async () => {
    await Broker.sendProcessingCompleted(payload, sourceHeaders);

    const envelope = sentEnvelope();

    expect(envelope.headers.eventType).toBe("video.processing.completed");
    expect(envelope.headers.source).toBe("fiapx-processor");
    expect(envelope.payload).toEqual(payload);
    expect(
      send.mock.calls
        .map(([call]) => call)
        .find((call): call is SendMessageCommand => call instanceof SendMessageCommand)?.input
        .QueueUrl,
    ).toBe(QUEUE_URL);
  });

  test("opens a producer span tagged with video.id and the messaging attributes", async () => {
    await Broker.sendProcessingCompleted(payload, sourceHeaders);

    const span = telemetry.spanNamed(`${COMPLETED_QUEUE_NAME} publish`);

    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.attributes["video.id"]).toBe(payload.processingJobId);
    expect(span?.attributes["messaging.system"]).toBe("aws_sqs");
    expect(span?.attributes["messaging.destination.name"]).toBe(COMPLETED_QUEUE_NAME);
    expect(span?.ended).toBe(true);
  });

  test("stamps the envelope with the producer span", async () => {
    await Broker.sendProcessingCompleted(payload, sourceHeaders);

    const span = telemetry.spanNamed(`${COMPLETED_QUEUE_NAME} publish`);

    expect(sentEnvelope().headers.traceparent).toBe(
      `00-${span?.spanContext().traceId}-${span?.spanContext().spanId}-01`,
    );
  });

  // How the worker actually calls it: the producer span is a child of the consumer span, so
  // the trace opened by the API reaches the notifier unbroken.
  test("keeps the incoming trace when published from inside a consumer span", async () => {
    const consumer = startConsumerSpan("requested", INCOMING_TRACEPARENT);

    await withSpan(consumer, () => Broker.sendProcessingCompleted(payload, sourceHeaders));
    consumer.end();

    const producer = telemetry.spanNamed(`${COMPLETED_QUEUE_NAME} publish`);

    expect(producer?.spanContext().traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(producer?.parentSpanContext?.spanId).toBe(consumer.spanContext().spanId);
    expect(sentEnvelope().headers.traceparent).toBe(
      `00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${producer?.spanContext().spanId}-01`,
    );
  });

  test("ends the span and rethrows when publishing fails", async () => {
    send.mockImplementation((async (command: unknown) => {
      if (command instanceof GetQueueUrlCommand) return { QueueUrl: QUEUE_URL };
      throw new Error("publish failed");
    }) as typeof sqsClient.send);

    await expect(Broker.sendProcessingCompleted(payload, sourceHeaders)).rejects.toThrow(
      "publish failed",
    );

    expect(telemetry.spanNamed(`${COMPLETED_QUEUE_NAME} publish`)?.ended).toBe(true);
  });
});

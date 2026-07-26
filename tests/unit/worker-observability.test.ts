import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getQueueNameForTelemetry } from "../../src/config";
import { runWorker } from "../../src/worker";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../mocks/observability";
import { createWorkerDependencies, mockQueueMessage } from "../mocks/worker";

const INCOMING_TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// Derived the same way the worker does, so the queue-name binding (or its absence) cannot
// break the assertion.
const CONSUMER_SPAN_NAME = `${getQueueNameForTelemetry("VIDEO_PROCESSING_REQUESTED")} process`;

let telemetry: InMemoryTelemetry;

beforeEach(() => {
  telemetry = setupInMemoryTelemetry();
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await telemetry.dispose();
  mock.restore();
});

describe("runWorker tracing", () => {
  test("opens a consumer span inside the incoming trace, tagged with video.id", async () => {
    await runWorker(createWorkerDependencies());

    const span = telemetry.spanNamed(CONSUMER_SPAN_NAME);

    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.spanContext().traceId).toBe(INCOMING_TRACE_ID);
    expect(span?.parentSpanContext?.spanId).toBe("bbbbbbbbbbbbbbbb");
    expect(span?.attributes["video.id"]).toBe(mockQueueMessage.body.processingJobId);
    expect(span?.attributes["messaging.system"]).toBe("aws_sqs");
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("marks the consumer span as failed and records the exception when processing fails", async () => {
    const processVideo = mock(async () => {
      throw new Error("ffmpeg failed");
    });

    await runWorker(createWorkerDependencies({ processVideo }));

    const span = telemetry.spanNamed(CONSUMER_SPAN_NAME);

    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe("ffmpeg failed");
    expect(span?.events.map((event) => event.name)).toContain("exception");
  });

  test("emits no span when there is no message to process", async () => {
    await runWorker(createWorkerDependencies({ message: null }));

    expect(telemetry.spans()).toHaveLength(0);
  });

  test("correlates the worker logs with the consumer span", async () => {
    await runWorker(createWorkerDependencies());

    const record = telemetry
      .logRecords()
      .find((entry) => entry.body === "SQS message processed and deleted");

    expect(record?.spanContext?.traceId).toBe(INCOMING_TRACE_ID);
    expect(record?.attributes.processingJobId).toBe(mockQueueMessage.body.processingJobId);
  });
});

describe("runWorker metrics", () => {
  test.each([
    ["succeeded", undefined],
    [
      "failed",
      mock(async () => {
        throw new Error("ffmpeg failed");
      }),
    ],
  ])("records videos.processed with status %s", async (status, processVideo) => {
    await runWorker(
      createWorkerDependencies(processVideo ? { processVideo } : {}),
    );

    const metric = await telemetry.metricNamed("videos.processed");

    expect(metric?.dataPoints.map((point) => [point.attributes.status, point.value])).toEqual([
      [status, 1],
    ]);
  });

  test("records the processing duration tagged with the outcome", async () => {
    await runWorker(createWorkerDependencies());

    const metric = await telemetry.metricNamed("videos.processing_duration_seconds");
    const [point] = metric?.dataPoints ?? [];

    expect(point?.attributes).toEqual({ status: "succeeded" });
    expect((point?.value as { count?: number }).count).toBe(1);
  });

  test("records no metric when there is no message to process", async () => {
    await runWorker(createWorkerDependencies({ message: null }));

    expect(await telemetry.metricNamed("videos.processed")).toBeUndefined();
  });
});

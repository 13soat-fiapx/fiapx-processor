import { SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { traceStep } from "../../../src/shared/observability/trace-step";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";

let telemetry: InMemoryTelemetry;

beforeEach(() => {
  telemetry = setupInMemoryTelemetry();
});

afterEach(async () => {
  await telemetry.dispose();
});

describe("traceStep", () => {
  test("wraps the phase in a named span and returns its result", async () => {
    const result = await traceStep("video.download", { "video.id": "job-123" }, async () => 42);

    const span = telemetry.spanNamed("video.download");

    expect(result).toBe(42);
    expect(span?.attributes["video.id"]).toBe("job-123");
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.ended).toBe(true);
  });

  test("makes the span active so nested steps become children", async () => {
    await traceStep("video.extract_frames", {}, async () => {
      trace.getActiveSpan()?.setAttribute("video.frames.count", 7);
      await traceStep("video.zip_upload", {}, async () => undefined);
    });

    const parent = telemetry.spanNamed("video.extract_frames");
    const child = telemetry.spanNamed("video.zip_upload");

    expect(parent?.attributes["video.frames.count"]).toBe(7);
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  test("records the exception, marks the span as failed and rethrows", async () => {
    const run = traceStep("video.download", {}, async () => {
      throw new Error("access denied");
    });

    await expect(run).rejects.toThrow("access denied");

    const span = telemetry.spanNamed("video.download");

    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe("access denied");
    expect(span?.events.map((event) => event.name)).toContain("exception");
    expect(span?.ended).toBe(true);
  });
});

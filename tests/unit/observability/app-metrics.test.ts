import { DataPointType } from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppMetrics } from "../../../src/shared/observability/app-metrics";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";

let telemetry: InMemoryTelemetry;

beforeEach(() => {
  telemetry = setupInMemoryTelemetry();
});

afterEach(async () => {
  await telemetry.dispose();
});

describe("AppMetrics", () => {
  test("counts processed videos per status", async () => {
    AppMetrics.recordProcessed("succeeded");
    AppMetrics.recordProcessed("succeeded");
    AppMetrics.recordProcessed("failed");

    const metric = await telemetry.metricNamed("videos.processed");

    expect(metric?.dataPointType).toBe(DataPointType.SUM);
    expect(
      metric?.dataPoints.map((point) => [point.attributes.status, point.value]),
    ).toEqual([
      ["succeeded", 2],
      ["failed", 1],
    ]);
  });

  test("records the processing duration histogram tagged with the status", async () => {
    AppMetrics.recordProcessingDuration(1.5, "failed");

    const metric = await telemetry.metricNamed("videos.processing_duration_seconds");
    const [point] = metric?.dataPoints ?? [];

    expect(metric?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(point?.attributes).toEqual({ status: "failed" });
    expect((point?.value as { sum?: number }).sum).toBe(1.5);
  });

  test("counts extracted frames without any tag", async () => {
    AppMetrics.recordFramesExtracted(12);
    AppMetrics.recordFramesExtracted(3);

    const metric = await telemetry.metricNamed("videos.frames_extracted");

    expect(metric?.dataPoints).toHaveLength(1);
    expect(metric?.dataPoints[0]?.value).toBe(15);
    expect(metric?.dataPoints[0]?.attributes).toEqual({});
  });

  test("never uses an id as a metric tag", async () => {
    AppMetrics.recordProcessed("succeeded");
    AppMetrics.recordProcessingDuration(0.2, "succeeded");
    AppMetrics.recordFramesExtracted(1);

    const names = [
      "videos.processed",
      "videos.processing_duration_seconds",
      "videos.frames_extracted",
    ];

    for (const name of names) {
      const metric = await telemetry.metricNamed(name);

      for (const point of metric?.dataPoints ?? []) {
        expect(Object.keys(point.attributes)).not.toContain("video.id");
        expect(Object.keys(point.attributes)).not.toContain("userId");
      }
    }
  });
});

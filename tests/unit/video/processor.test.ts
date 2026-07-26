import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { VideoProcessingMessage } from "../../../src/modules/broker/types";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";

const BUCKET = "fiapx-dev-artifacts-000000000000";

const message: VideoProcessingMessage = {
  processingJobId: "job-123",
  userId: "user-456",
  inputFile: { bucket: BUCKET, key: "videos/job-123/original.mp4", region: "us-east-1" },
  outputPrefix: "frames/job-123/",
};

const downloadFromAwsS3 = mock(async () => Buffer.from("fake-video"));
const uploadToAwsS3 = mock(async () => {});
const deleteFromAwsS3 = mock(async () => {});

mock.module("../../../src/shared/utils/upload-to-aws", () => ({
  downloadFromAwsS3,
  uploadToAwsS3,
  deleteFromAwsS3,
}));

/**
 * Stands in for ffmpeg: writes `frameCount` JPEGs into the frames directory the real command
 * would have written to, derived from the output pattern in the argv.
 */
function stubFfmpeg(frameCount: number, exitCode = 0) {
  return spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
    const framesDir = dirname(argv[5] as string);

    const exited = (async () => {
      if (exitCode === 0) {
        await mkdir(framesDir, { recursive: true });
        for (let i = 1; i <= frameCount; i++) {
          const name = `frame-${String(i).padStart(6, "0")}.jpg`;
          await writeFile(`${framesDir}/${name}`, `jpeg-${i}`);
        }
      }
      return exitCode;
    })();

    return { exited, stderr: new Response("ffmpeg boom").body };
  }) as unknown as typeof Bun.spawn);
}

let telemetry: InMemoryTelemetry;
let processVideo: typeof import("../../../src/modules/video/processor").processVideo;

beforeEach(async () => {
  telemetry = setupInMemoryTelemetry();
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});

  downloadFromAwsS3.mockClear();
  uploadToAwsS3.mockClear();
  deleteFromAwsS3.mockClear();

  ({ processVideo } = await import("../../../src/modules/video/processor"));
});

afterEach(async () => {
  await telemetry.dispose();
  mock.restore();
});

describe("processVideo", () => {
  test("downloads, extracts, zips and returns the result file", async () => {
    stubFfmpeg(3);

    const result = await processVideo(message);

    expect(downloadFromAwsS3).toHaveBeenCalledWith(BUCKET, message.inputFile.key);
    expect(result.bucket).toBe(BUCKET);
    expect(result.key).toBe("frames/job-123/frames.zip");
    expect(result.region).toBe("us-east-1");
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);

    // Three frames plus the zip.
    expect(uploadToAwsS3).toHaveBeenCalledTimes(4);
    expect(deleteFromAwsS3).toHaveBeenCalledWith(BUCKET, message.inputFile.key);
  });

  test("emits one span per processing phase, all tagged with video.id", async () => {
    stubFfmpeg(2);

    await processVideo(message);

    for (const name of ["video.download", "video.extract_frames", "video.zip_upload"]) {
      const span = telemetry.spanNamed(name);

      expect(span, `missing span ${name}`).toBeDefined();
      expect(span?.attributes["video.id"]).toBe("job-123");
      expect(span?.ended).toBe(true);
    }

    expect(telemetry.spanNamed("video.zip_upload")?.attributes["video.frames.count"]).toBe(2);
  });

  test("counts the extracted frames", async () => {
    stubFfmpeg(5);

    await processVideo(message);

    const metric = await telemetry.metricNamed("videos.frames_extracted");

    expect(metric?.dataPoints[0]?.value).toBe(5);
  });

  test("marks the extraction span as failed when ffmpeg exits non-zero", async () => {
    stubFfmpeg(0, 1);

    await expect(processVideo(message)).rejects.toThrow("ffmpeg failed with exit code 1");

    const span = telemetry.spanNamed("video.extract_frames");

    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.map((event) => event.name)).toContain("exception");
    expect(deleteFromAwsS3).not.toHaveBeenCalled();
  });

  test("fails when ffmpeg produced no frames", async () => {
    stubFfmpeg(0);

    await expect(processVideo(message)).rejects.toThrow(
      "No frames were extracted from the input video.",
    );

    expect(telemetry.spanNamed("video.zip_upload")?.status.code).toBe(SpanStatusCode.ERROR);
  });

  test("explains how to fix a missing ffmpeg executable", async () => {
    spyOn(Bun, "spawn").mockImplementation((() => {
      throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    }) as unknown as typeof Bun.spawn);

    await expect(processVideo(message)).rejects.toThrow("ffmpeg executable not found");
  });
});

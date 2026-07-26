import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { VideoProcessingMessage } from "../../../src/modules/broker/types";
import { processVideo } from "../../../src/modules/video/processor";
import { s3Client } from "../../../src/shared/aws";
import { type InMemoryTelemetry, setupInMemoryTelemetry } from "../../mocks/observability";

const BUCKET = "fiapx-dev-artifacts-000000000000";

const message: VideoProcessingMessage = {
  processingJobId: "job-123",
  userId: "user-456",
  inputFile: { bucket: BUCKET, key: "videos/job-123/original.mp4", region: "us-east-1" },
  outputPrefix: "frames/job-123/",
};

/**
 * S3 is faked at the client seam rather than by mocking `shared/utils/upload-to-aws`:
 * `mock.module` registers process-globally with no unregister, so a module-level mock here
 * leaks into `tests/unit/shared/utils/upload-to-aws.test.ts` and blanks out its spy.
 */
let send: ReturnType<typeof spyOn<typeof s3Client, "send">>;

function sentCommands<T>(type: new (...args: never[]) => T): T[] {
  return send.mock.calls
    .map(([call]) => call as unknown)
    .filter((call): call is T => call instanceof type);
}

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

beforeEach(() => {
  telemetry = setupInMemoryTelemetry();
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});

  send = spyOn(s3Client, "send").mockImplementation((async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
    }
    return {};
  }) as typeof s3Client.send);
});

afterEach(async () => {
  await telemetry.dispose();
  mock.restore();
});

describe("processVideo", () => {
  test("downloads, extracts, zips and returns the result file", async () => {
    stubFfmpeg(3);

    const result = await processVideo(message);

    expect(sentCommands(GetObjectCommand)[0]?.input).toEqual({
      Bucket: BUCKET,
      Key: message.inputFile.key,
    });
    expect(result.bucket).toBe(BUCKET);
    expect(result.key).toBe("frames/job-123/frames.zip");
    expect(result.region).toBe("us-east-1");
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);

    // Three frames plus the zip.
    expect(sentCommands(PutObjectCommand)).toHaveLength(4);
    expect(sentCommands(DeleteObjectCommand)[0]?.input).toEqual({
      Bucket: BUCKET,
      Key: message.inputFile.key,
    });
  });

  test("uploads the frames as JPEG and the archive as ZIP", async () => {
    stubFfmpeg(2);

    await processVideo(message);

    const puts = sentCommands(PutObjectCommand);
    // `uploadFrames` fires the frames through `Promise.all`, so only the set that goes up is
    // guaranteed, never the order. The zip is awaited afterwards, so it is always last.
    const frames = puts.slice(0, -1);
    const zip = puts[puts.length - 1];

    expect(frames.map((put) => String(put.input.Key)).sort((a, b) => a.localeCompare(b))).toEqual([
      "frames/job-123/frame-000001.jpg",
      "frames/job-123/frame-000002.jpg",
    ]);
    expect(frames.map((put) => put.input.ContentType)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(zip?.input.ContentType).toBe("application/zip");
    expect(zip?.input.Key).toBe("frames/job-123/frames.zip");
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
    expect(sentCommands(DeleteObjectCommand)).toBeEmpty();
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

  // Only ENOENT gets translated; anything else has to reach the caller as thrown.
  test("propagates a spawn failure that is not ENOENT unchanged", async () => {
    spyOn(Bun, "spawn").mockImplementation((() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }) as unknown as typeof Bun.spawn);

    await expect(processVideo(message)).rejects.toThrow("permission denied");
  });
});

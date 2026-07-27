import { trace } from "@opentelemetry/api";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { config } from "../../config";
import { AppMetrics } from "../../shared/observability/app-metrics";
import { logger } from "../../shared/observability/logger";
import { traceStep } from "../../shared/observability/trace-step";
import { resolveBucketName } from "../../shared/utils/bucket-name-resolver";
import {
  deleteFromAwsS3,
  downloadFromAwsS3,
  getObjectSize,
  uploadToAwsS3,
} from "../../shared/utils/upload-to-aws";
import type { VideoProcessingMessage } from "../broker/types";
import type { ProcessingJobResultFile } from "../processing-jobs/types";

export abstract class ProcessingLimitExceededError extends Error {
  abstract readonly code: string;
}

export class FileSizeExceededError extends ProcessingLimitExceededError {
  readonly code = "PROC-9002";
  constructor(sizeBytes: number, limitBytes: number) {
    super(`Video file size ${sizeBytes} bytes exceeds the ${limitBytes} bytes limit.`);
  }
}

export class VideoDurationExceededError extends ProcessingLimitExceededError {
  readonly code = "PROC-9001";
  constructor(durationSeconds: number, limitSeconds: number) {
    super(`Video duration ${durationSeconds}s exceeds the ${limitSeconds}s limit.`);
  }
}

export async function processVideo(message: VideoProcessingMessage): Promise<ProcessingJobResultFile> {
  const bucket = message.inputFile.bucket ?? await resolveBucketName(config.s3BucketPrefix);
  const workdir = join(tmpdir(), `fiapx-video-${message.processingJobId}-${randomUUID()}`);
  const videoPath = join(workdir, "input-video");
  const framesDir = join(workdir, "frames");
  const region = message.inputFile.region ?? config.awsRegion;

  await mkdir(framesDir, { recursive: true });

  const spanAttributes = { "video.id": message.processingJobId };

  try {
    await traceStep("video.download", spanAttributes, async () => {
      const sizeBytes = await getObjectSize(bucket, message.inputFile.key);

      if (sizeBytes > config.maxFileSizeBytes) {
        throw new FileSizeExceededError(sizeBytes, config.maxFileSizeBytes);
      }

      logger.info(
        {
          bucket,
          key: message.inputFile.key,
          processingJobId: message.processingJobId,
        },
        "start downloading input video from S3",
      );
      const video = await downloadFromAwsS3(bucket, message.inputFile.key);

      // Safety net for a mismatched Content-Length, not the primary guard: the check above
      // already keeps oversized files from being downloaded at all.
      if (video.byteLength > config.maxFileSizeBytes) {
        throw new FileSizeExceededError(video.byteLength, config.maxFileSizeBytes);
      }

      await writeFile(videoPath, video);
    });

    await traceStep("video.validate_duration", spanAttributes, async () => {
      const durationSeconds = await probeDurationSeconds(videoPath);

      if (durationSeconds > config.maxVideoDurationSeconds) {
        throw new VideoDurationExceededError(durationSeconds, config.maxVideoDurationSeconds);
      }
    });

    await traceStep("video.extract_frames", spanAttributes, () =>
      extractFrames(videoPath, framesDir),
    );

    const { uploadedFrames, resultFile } = await traceStep(
      "video.zip_upload",
      spanAttributes,
      async () => {
        const uploaded = await uploadFrames(
          bucket,
          message.processingJobId,
          framesDir,
          message.outputPrefix,
        );

        trace.getActiveSpan()?.setAttribute("video.frames.count", uploaded);

        return {
          uploadedFrames: uploaded,
          resultFile: await uploadFramesZip(
            bucket,
            region,
            message.processingJobId,
            framesDir,
            message.outputPrefix,
          ),
        };
      },
    );

    AppMetrics.recordFramesExtracted(uploadedFrames);

    logger.info(
      {
        bucket,
        key: message.inputFile.key,
        processingJobId: message.processingJobId,
      },
      "deleting input video from S3",
    );
    await deleteFromAwsS3(bucket, message.inputFile.key);

    logger.info(
      {
        processingJobId: message.processingJobId,
        userId: message.userId,
        uploadedFrames,
        resultFileKey: resultFile.key,
        resultFileId: resultFile.id,
      },
      "video processed",
    );

    return resultFile;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function extractFrames(videoPath: string, framesDir: string) {
  const outputPattern = join(framesDir, "frame-%06d.jpg");
  const proc = spawnFfmpeg(videoPath, outputPattern);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg failed with exit code ${exitCode}: ${error}`);
  }
}

function spawnFfmpeg(videoPath: string, outputPattern: string) {
  try {
    return Bun.spawn(
      [config.ffmpegPath, "-i", videoPath, "-vf", "fps=1", outputPattern],
      { stderr: "pipe" },
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;

    if (code === "ENOENT") {
      throw new Error(
        `ffmpeg executable not found: ${config.ffmpegPath}. Install ffmpeg or set FFMPEG_PATH to the executable path.`,
      );
    }

    throw error;
  }
}

async function probeDurationSeconds(videoPath: string): Promise<number> {
  const proc = spawnFfprobe(videoPath);

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`ffprobe failed with exit code ${exitCode}: ${error}`);
  }

  return Number.parseFloat(stdout);
}

function spawnFfprobe(videoPath: string) {
  try {
    return Bun.spawn(
      [
        config.ffprobePath,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;

    if (code === "ENOENT") {
      throw new Error(
        `ffprobe executable not found: ${config.ffprobePath}. Install ffmpeg (which bundles ffprobe) or set FFPROBE_PATH to the executable path.`,
      );
    }

    throw error;
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

async function uploadFrames(
  bucket: string,
  processingJobId: string,
  framesDir: string,
  outputPrefix?: string,
) {
  const files = await readdir(framesDir);
  const frameFiles = files.filter((file) => file.endsWith(".jpg")).sort((a, b) => a.localeCompare(b));
  const normalizedPrefix = outputPrefix ? stripTrailingSlashes(outputPrefix) : outputPrefix;

  await Promise.all(
    frameFiles.map(async (file) => {
      const frame = await readFile(join(framesDir, file));
      const key = normalizedPrefix
        ? `${normalizedPrefix}/${file}`
        : `${config.framePrefix}/${processingJobId}/${file}`;

      await uploadToAwsS3(bucket, key, frame, "image/jpeg");
    }),
  );

  return frameFiles.length;
}

async function uploadFramesZip(
  bucket: string,
  region: string,
  processingJobId: string,
  framesDir: string,
  outputPrefix?: string,
): Promise<ProcessingJobResultFile> {
  const files = await readdir(framesDir);
  const frameFiles = files.filter((file) => file.endsWith(".jpg")).sort((a, b) => a.localeCompare(b));

  if (frameFiles.length === 0) {
    throw new Error("No frames were extracted from the input video.");
  }

  const entries: Record<string, Uint8Array> = {};
  for (const file of frameFiles) {
    entries[file] = await readFile(join(framesDir, file));
  }

  const zip = zipSync(entries, { level: 6 });
  const normalizedPrefix = outputPrefix ? stripTrailingSlashes(outputPrefix) : outputPrefix;
  const key = normalizedPrefix
    ? `${normalizedPrefix}/frames.zip`
    : `${config.framePrefix}/${processingJobId}/frames.zip`;
  const checksum = createHash("sha256").update(zip).digest("hex");

  await uploadToAwsS3(bucket, key, zip, "application/zip");

  return {
    id: randomUUID(),
    bucket,
    key,
    region,
    sizeBytes: zip.byteLength,
    checksum,
  };
}

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
  uploadToAwsS3,
} from "../../shared/utils/upload-to-aws";
import type { VideoProcessingMessage } from "../broker/types";
import type { ProcessingJobResultFile } from "../processing-jobs/types";

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
      logger.info(
        {
          bucket,
          key: message.inputFile.key,
          processingJobId: message.processingJobId,
        },
        "start downloading input video from S3",
      );
      const video = await downloadFromAwsS3(bucket, message.inputFile.key);
      await writeFile(videoPath, video);
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

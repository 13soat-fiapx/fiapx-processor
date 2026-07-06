import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config";
import { resolveBucketName } from "../../shared/utils/bucket-name-resolver";
import {
  deleteFromAwsS3,
  downloadFromAwsS3,
  uploadToAwsS3,
} from "../../shared/utils/upload-to-aws";
import type { VideoProcessingMessage } from "../broker/types";

export async function processVideo(message: VideoProcessingMessage) {
  const bucket = message.inputFile.bucket ?? await resolveBucketName(config.s3BucketPrefix);
  const workdir = join(tmpdir(), `fiapx-video-${message.processingJobId}-${randomUUID()}`);
  const videoPath = join(workdir, "input-video");
  const framesDir = join(workdir, "frames");

  await mkdir(framesDir, { recursive: true });

  try {
    console.log(
      {
        bucket,
        key: message.inputFile.key,
        processingJobId: message.processingJobId,
      },
      "start downloading input video from S3",
    );
    const video = await downloadFromAwsS3(bucket, message.inputFile.key);
    await writeFile(videoPath, video);

    await extractFrames(videoPath, framesDir);
    const uploadedFrames = await uploadFrames(
      bucket,
      message.processingJobId,
      framesDir,
      message.outputPrefix,
    );

    console.log(
      {
        bucket,
        key: message.inputFile.key,
        processingJobId: message.processingJobId,
      },
      "deleting input video from S3",
    );
    await deleteFromAwsS3(bucket, message.inputFile.key);

    console.log(
      {
        processingJobId: message.processingJobId,
        userId: message.userId,
        uploadedFrames,
      },
      "video processed",
    );
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

async function uploadFrames(
  bucket: string,
  processingJobId: string,
  framesDir: string,
  outputPrefix?: string,
) {
  const files = await readdir(framesDir);
  const frameFiles = files.filter((file) => file.endsWith(".jpg")).sort();
  const normalizedPrefix = outputPrefix?.replace(/\/+$/, "");

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

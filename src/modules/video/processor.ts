import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config";
import {
  downloadFromAwsS3,
  uploadToAwsS3,
} from "../../shared/utils/upload-to-aws";
import type { VideoProcessingMessage } from "../broker/types";

export async function processVideo(message: VideoProcessingMessage) {
  const bucket = message.bucket ?? config.s3Bucket;
  const workdir = join(tmpdir(), `fiapx-video-${message.videoId}-${randomUUID()}`);
  const videoPath = join(workdir, "input-video");
  const framesDir = join(workdir, "frames");

  await mkdir(framesDir, { recursive: true });

  try {
    const video = await downloadFromAwsS3(bucket, message.key);
    await writeFile(videoPath, video);

    await extractFrames(videoPath, framesDir);
    const uploadedFrames = await uploadFrames(bucket, message.videoId, framesDir);

    console.log(
      {
        videoId: message.videoId,
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
  const proc = Bun.spawn(
    [config.ffmpegPath, "-i", videoPath, "-vf", "fps=1", outputPattern],
    { stderr: "pipe" },
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg failed with exit code ${exitCode}: ${error}`);
  }
}

async function uploadFrames(bucket: string, videoId: string, framesDir: string) {
  const files = await readdir(framesDir);
  const frameFiles = files.filter((file) => file.endsWith(".jpg")).sort();

  await Promise.all(
    frameFiles.map(async (file) => {
      const frame = await readFile(join(framesDir, file));
      const key = `${config.framePrefix}/${videoId}/${file}`;

      await uploadToAwsS3(bucket, key, frame, "image/jpeg");
    }),
  );

  return frameFiles.length;
}
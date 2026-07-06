export const config = {
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  awsEndpoint: process.env.AWS_ENDPOINT,
  processingJobsTableName: process.env.PROCESSING_JOBS_TABLE_NAME ?? "fiapx-dev-videos-db",
  s3BucketPrefix: process.env.S3_BUCKET_PREFIX ?? "fiapx-dev-artifacts",
  framePrefix: process.env.FRAME_PREFIX ?? "frames",
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
};

export function getQueueName(eventType: string): string {
  const key = `SQS_QUEUE_NAMES_${eventType}`;
  const name = process.env[key];
  if (!name) throw new Error(`Queue name not configured: ${key}`);
  return name;
}

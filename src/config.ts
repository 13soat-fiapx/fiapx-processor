export const config = {
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  awsEndpoint: process.env.AWS_ENDPOINT,
  processingJobsTableName: process.env.PROCESSING_JOBS_TABLE_NAME ?? "fiapx-dev-videos-db",
  s3BucketPrefix: process.env.S3_BUCKET_PREFIX ?? "fiapx-dev-artifacts",
  framePrefix: process.env.FRAME_PREFIX ?? "frames",
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  appName: process.env.APP_NAME ?? "processor",
  appVersion: process.env.APP_VERSION ?? "1.0.0",
  environment: (process.env.APP_ENV ?? "development").toLowerCase(),
  datadogApiKey: process.env.DD_API_KEY ?? "",
  datadogOtlpEndpoint: process.env.DD_OTLP_ENDPOINT ?? "https://otlp.us5.datadoghq.com",
};

export function getQueueName(eventType: string): string {
  const key = `SQS_QUEUE_NAMES_${eventType}`;
  const name = process.env[key];
  if (!name) throw new Error(`Queue name not configured: ${key}`);
  return name;
}

/**
 * Queue name for span attributes only. Never throws: a missing binding must not turn
 * telemetry into a processing failure — the real call path already fails loudly on its own.
 */
export function getQueueNameForTelemetry(eventType: string): string {
  try {
    return getQueueName(eventType);
  } catch {
    return eventType.toLowerCase().replaceAll("_", "-");
  }
}

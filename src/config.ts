export const config = {
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  awsEndpoint: process.env.AWS_ENDPOINT,
  sqsQueueName: process.env.SQS_QUEUE_NAME ?? "video-processing",
  sqsQueueUrl: process.env.SQS_QUEUE_URL,
  s3Bucket: process.env.S3_BUCKET ?? "videos",
  framePrefix: process.env.FRAME_PREFIX ?? "frames",
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
};

export function getQueueUrl() {
  if (config.sqsQueueUrl) {
    return config.sqsQueueUrl;
  }

  if (config.awsEndpoint) {
    return `${config.awsEndpoint}/000000000000/${config.sqsQueueName}`;
  }

  throw new Error("SQS_QUEUE_URL is required when AWS_ENDPOINT is not set");
}

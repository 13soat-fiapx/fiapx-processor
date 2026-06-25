import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { STSClient } from "@aws-sdk/client-sts";
import { config } from "../config";

const clientConfig = {
  region: config.awsRegion,
  endpoint: config.awsEndpoint,
  forcePathStyle: Boolean(config.awsEndpoint),
  credentials: config.awsEndpoint
    ? {
        accessKeyId: "test",
        secretAccessKey: "test",
      }
    : undefined,
};

export const s3Client = new S3Client(clientConfig);
export const sqsClient = new SQSClient(clientConfig);
export const stsClient = new STSClient(clientConfig);

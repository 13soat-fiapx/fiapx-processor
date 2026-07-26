import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { STSClient } from "@aws-sdk/client-sts";
import { config } from "../config";
import { instrumentAwsClient } from "./observability/aws-middleware";

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

export const s3Client = instrumentAwsClient(new S3Client(clientConfig));
export const sqsClient = instrumentAwsClient(new SQSClient(clientConfig));
export const stsClient = instrumentAwsClient(new STSClient(clientConfig));
export const dynamoDbClient = instrumentAwsClient(new DynamoDBClient(clientConfig));

import {
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { config } from "../../config";
import { dynamoDbClient } from "../../shared/aws";
import type {
  ProcessingJob,
  ProcessingJobResultFile,
  ProcessingJobStatus,
  S3ObjectReference,
} from "./types";

function getString(
  item: Record<string, AttributeValue>,
  key: string,
): string | undefined {
  const value = item[key];
  return value && "S" in value ? value.S : undefined;
}

function getS3Object(
  item: Record<string, AttributeValue>,
  key: string,
): S3ObjectReference | undefined {
  const value = item[key];
  if (!value || !("M" in value) || !value.M) return undefined;

  const bucket = value.M.bucket;
  const objectKey = value.M.key;
  const region = value.M.region;

  if (
    !bucket || !("S" in bucket) || !bucket.S ||
    !objectKey || !("S" in objectKey) || !objectKey.S ||
    !region || !("S" in region) || !region.S
  ) {
    return undefined;
  }

  return {
    bucket: bucket.S,
    key: objectKey.S,
    region: region.S,
  };
}

function toProcessingJob(
  item: Record<string, AttributeValue> | undefined,
): ProcessingJob | null {
  if (!item) return null;

  const id = getString(item, "id");
  const userId = getString(item, "userId");
  const status = getString(item, "status") as ProcessingJobStatus | undefined;

  if (!id || !userId || !status) {
    throw new Error("Processing job item is missing id, userId or status");
  }

  return {
    id,
    userId,
    status,
    resultFileId: getString(item, "resultFileId"),
    resultFile: getS3Object(item, "resultFile"),
    errorMessage: getString(item, "errorMessage"),
    createdAt: getString(item, "createdAt"),
    updatedAt: getString(item, "updatedAt"),
  };
}

export abstract class ProcessingJobRepository {
  static async findById(processingJobId: string): Promise<ProcessingJob | null> {
    const response = await dynamoDbClient.send(
      new GetItemCommand({
        TableName: config.processingJobsTableName,
        Key: {
          id: { S: processingJobId },
        },
      }),
    );

    return toProcessingJob(response.Item);
  }

  static async updateStatus(input: {
    processingJobId: string;
    status: ProcessingJobStatus;
    resultFile?: ProcessingJobResultFile;
    errorMessage?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const expressionAttributeNames: Record<string, string> = {
      "#status": "status",
      "#updatedAt": "updatedAt",
    };
    const expressionAttributeValues: Record<string, AttributeValue> = {
      ":status": { S: input.status },
      ":updatedAt": { S: now },
    };
    const updateExpressions = ["#status = :status", "#updatedAt = :updatedAt"];

    if (input.status === "processing") {
      expressionAttributeNames["#progressPercentage"] = "progressPercentage";
      expressionAttributeValues[":progressPercentage"] = { N: "0" };
      updateExpressions.push("#progressPercentage = :progressPercentage");
    }

    if (input.status === "succeeded") {
      if (!input.resultFile) {
        throw new Error("Result file metadata is required when completing a processing job.");
      }

      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeNames["#progressPercentage"] = "progressPercentage";
      expressionAttributeNames["#resultFileId"] = "resultFileId";
      expressionAttributeNames["#resultFile"] = "resultFile";
      expressionAttributeNames["#resultSizeBytes"] = "resultSizeBytes";
      expressionAttributeNames["#resultChecksum"] = "resultChecksum";
      expressionAttributeValues[":completedAt"] = { S: now };
      expressionAttributeValues[":progressPercentage"] = { N: "100" };
      expressionAttributeValues[":resultFileId"] = { S: input.resultFile.id };
      expressionAttributeValues[":resultFile"] = {
        M: {
          bucket: { S: input.resultFile.bucket },
          key: { S: input.resultFile.key },
          region: { S: input.resultFile.region },
        },
      };
      expressionAttributeValues[":resultSizeBytes"] = {
        N: input.resultFile.sizeBytes.toString(),
      };
      expressionAttributeValues[":resultChecksum"] = {
        S: input.resultFile.checksum,
      };
      updateExpressions.push(
        "#completedAt = :completedAt",
        "#progressPercentage = :progressPercentage",
        "#resultFileId = :resultFileId",
        "#resultFile = :resultFile",
        "#resultSizeBytes = :resultSizeBytes",
        "#resultChecksum = :resultChecksum",
      );
    }

    if (input.status === "failed") {
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = { S: now };
      updateExpressions.push("#completedAt = :completedAt");
    }

    if (input.errorMessage) {
      expressionAttributeNames["#errorMessage"] = "errorMessage";
      expressionAttributeValues[":errorMessage"] = { S: input.errorMessage };
      updateExpressions.push("#errorMessage = :errorMessage");
    }

    await dynamoDbClient.send(
      new UpdateItemCommand({
        TableName: config.processingJobsTableName,
        Key: {
          id: { S: input.processingJobId },
        },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      }),
    );
  }
}

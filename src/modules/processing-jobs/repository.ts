import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { config } from "../../config";
import { dynamoDbClient } from "../../shared/aws";
import type { ProcessingJob, ProcessingJobStatus } from "./types";

function getString(
  item: Record<string, AttributeValue>,
  key: string,
): string | undefined {
  const value = item[key];
  return value && "S" in value ? value.S : undefined;
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
    outputFileKey: getString(item, "outputFileKey"),
    errorMessage: getString(item, "errorMessage"),
    createdAt: getString(item, "createdAt"),
    updatedAt: getString(item, "updatedAt"),
  };
}

export abstract class ProcessingJobRepository {
  static async createPending(input: {
    processingJobId: string;
    userId: string;
  }): Promise<void> {
    const now = new Date().toISOString();

    await dynamoDbClient.send(
      new PutItemCommand({
        TableName: config.processingJobsTableName,
        Item: {
          id: { S: input.processingJobId },
          userId: { S: input.userId },
          status: { S: "PENDING" },
          createdAt: { S: now },
          updatedAt: { S: now },
        },
      }),
    );
  }

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
    outputFileKey?: string;
    errorMessage?: string;
  }): Promise<void> {
    const expressionAttributeNames: Record<string, string> = {
      "#status": "status",
      "#updatedAt": "updatedAt",
    };
    const expressionAttributeValues: Record<string, AttributeValue> = {
      ":status": { S: input.status },
      ":updatedAt": { S: new Date().toISOString() },
    };
    const updateExpressions = ["#status = :status", "#updatedAt = :updatedAt"];

    if (input.outputFileKey) {
      expressionAttributeNames["#outputFileKey"] = "outputFileKey";
      expressionAttributeValues[":outputFileKey"] = { S: input.outputFileKey };
      updateExpressions.push("#outputFileKey = :outputFileKey");
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

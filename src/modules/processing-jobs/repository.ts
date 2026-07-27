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
  ProcessingMessage,
  S3ObjectReference,
} from "./types";

const processingMessages = {
  started: {
    code: "PROC-0003",
    message: "Processing started.",
    severity: "info",
  },
  completed: {
    code: "PROC-1000",
    message: "Processing completed successfully.",
    severity: "info",
  },
  failed: {
    code: "PROC-9000",
    severity: "error",
  },
} as const;

function buildProcessingMessage(input: Omit<ProcessingMessage, "createdAt">): ProcessingMessage {
  return {
    ...input,
    createdAt: new Date().toISOString(),
  };
}

function toMessageAttributeValue(message: ProcessingMessage): AttributeValue {
  return {
    M: {
      Code: { S: message.code },
      Message: { S: message.message },
      Severity: { S: message.severity },
      CreatedAt: { S: message.createdAt ?? new Date().toISOString() },
    },
  };
}

function getNumber(
  item: Record<string, AttributeValue>,
  key: string,
): number | undefined {
  const value = item[key];
  if (!value || !("N" in value) || value.N === undefined) return undefined;

  const parsed = Number(value.N);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getMessages(
  item: Record<string, AttributeValue>,
  key: string,
): ProcessingMessage[] {
  const value = item[key];
  if (!value || !("L" in value) || !value.L) return [];

  return value.L.flatMap((entry) => {
    if (!("M" in entry) || !entry.M) return [];

    const code = entry.M.Code ?? entry.M.code;
    const message = entry.M.Message ?? entry.M.message;
    const severity = entry.M.Severity ?? entry.M.severity;
    const createdAt = entry.M.CreatedAt ?? entry.M.createdAt;

    if (
      !code || !("S" in code) || !code.S ||
      !message || !("S" in message) || !message.S ||
      !severity || !("S" in severity) || !severity.S
    ) {
      return [];
    }

    return [{
      code: code.S,
      message: message.S,
      severity: severity.S as ProcessingMessage["severity"],
      createdAt: createdAt && "S" in createdAt ? createdAt.S : undefined,
    }];
  });
}

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

  const bucket = value.M.Bucket ?? value.M.bucket;
  const objectKey = value.M.Key ?? value.M.key;
  const region = value.M.Region ?? value.M.region;

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
  const userName = getString(item, "userName");
  const userEmail = getString(item, "userEmail");
  const status = getString(item, "status") as ProcessingJobStatus | undefined;

  if (!id || !userId || !userName || !userEmail || !status) {
    throw new Error("Processing job item is missing id, userId, userName, userEmail or status");
  }

  return {
    id,
    userId,
    userName,
    userEmail,
    status,
    resultFileId: getString(item, "resultFileId"),
    resultFile: getS3Object(item, "resultFile"),
    resultSizeBytes: getNumber(item, "resultSizeBytes"),
    resultChecksum: getString(item, "resultChecksum"),
    messages: getMessages(item, "messages"),
    errorMessage: getString(item, "errorMessage"),
    createdAt: getString(item, "createdAt"),
    updatedAt: getString(item, "updatedAt"),
    completedAt: getString(item, "completedAt"),
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
    errorCode?: string;
  }): Promise<ProcessingJob> {
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
    const messages: ProcessingMessage[] = [];

    if (input.status === "processing") {
      expressionAttributeNames["#progressPercentage"] = "progressPercentage";
      expressionAttributeValues[":progressPercentage"] = { N: "0" };
      updateExpressions.push("#progressPercentage = :progressPercentage");
      messages.push(buildProcessingMessage(processingMessages.started));
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
          Bucket: { S: input.resultFile.bucket },
          Key: { S: input.resultFile.key },
          Region: { S: input.resultFile.region },
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
      messages.push(buildProcessingMessage(processingMessages.completed));
    }

    if (input.status === "failed") {
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = { S: now };
      updateExpressions.push("#completedAt = :completedAt");
      messages.push(buildProcessingMessage({
        code: input.errorCode ?? processingMessages.failed.code,
        severity: processingMessages.failed.severity,
        message: input.errorMessage ?? "Video processing failed.",
      }));
    }

    if (messages.length > 0) {
      expressionAttributeNames["#messages"] = "messages";
      expressionAttributeValues[":emptyMessages"] = { L: [] };
      expressionAttributeValues[":messages"] = {
        L: messages.map(toMessageAttributeValue),
      };
      updateExpressions.push(
        "#messages = list_append(if_not_exists(#messages, :emptyMessages), :messages)",
      );
    }

    const response = await dynamoDbClient.send(
      new UpdateItemCommand({
        TableName: config.processingJobsTableName,
        Key: {
          id: { S: input.processingJobId },
        },
        ConditionExpression: "attribute_exists(id)",
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }),
    );

    const updatedJob = toProcessingJob(response.Attributes);

    if (!updatedJob) {
      throw new Error(`Processing job '${input.processingJobId}' was not returned after status update.`);
    }

    return updatedJob;
  }
}

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { sqsClient } from "../../shared/aws";
import { resolveQueueUrl } from "../../shared/utils/queue-url-resolver";
import { ProcessingJobService } from "../processing-jobs/service";
import type { BrokerModel } from "./model";
import type {
  QueueMessage,
  VideoProcessingEvent,
  VideoProcessingMessage,
} from "./types";

function parseVideoProcessingMessage(body: string | undefined): VideoProcessingMessage {
  if (!body) {
    throw new Error("SQS message body is empty");
  }

  const message = JSON.parse(body.replace(/^\uFEFF/, "")) as Partial<VideoProcessingEvent>
  const payload = message.payload;

  if (!payload) {
    throw new Error("SQS message body must include payload");
  }


  if (!payload.processingJobId || !payload.userId || !payload.inputFile?.key) {
    throw new Error("SQS message body must include processingJobId, userId and inputFile.key");
  }

  return {
    processingJobId: payload.processingJobId,
    userId: payload.userId,
    inputFile: payload.inputFile,
    outputPrefix: payload.outputPrefix,
    requestedAt: payload.requestedAt,
  };
}

function buildVideoProcessingEvent(payload: VideoProcessingMessage): VideoProcessingEvent {
  const occurredAt = new Date().toISOString();

  return {
    headers: {
      eventId: randomUUID(),
      eventType: "VideoProcessingRequested",
      eventVersion: "1.0",
      occurredAt,
      source: "fiapx-video-processor",
    },
    payload: {
      ...payload,
      requestedAt: payload.requestedAt ?? occurredAt,
    },
  };
}

export abstract class Broker {
  static async sendFrame(payload: BrokerModel["brokerRequest"]) {
    const queueUrl = await resolveQueueUrl("VIDEO_PROCESSING_REQUESTED");
    const event = buildVideoProcessingEvent(payload);

    await ProcessingJobService.createPending({
      processingJobId: payload.processingJobId,
      userId: payload.userId,
    });

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event),
      }),
    );

    console.log(
      {
        processingJobId: payload.processingJobId,
        userId: payload.userId,
      },
      "video processing request published",
    );
  }

  static async receiveVideoMessage(): Promise<QueueMessage | null> {
    const queueUrl = await resolveQueueUrl("VIDEO_PROCESSING_REQUESTED");
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 300,
      }),
    );

    const [message] = response.Messages ?? [];

    if (!message?.ReceiptHandle) {
      return null;
    }

    return {
      body: parseVideoProcessingMessage(message.Body),
      receiptHandle: message.ReceiptHandle,
      messageId: message.MessageId,
    };
  }

  static async deleteVideoMessage(receiptHandle: string) {
    const queueUrl = await resolveQueueUrl("VIDEO_PROCESSING_REQUESTED");
    await sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  static async extendVideoMessageVisibility(receiptHandle: string, visibilityTimeout = 300) {
    const queueUrl = await resolveQueueUrl("VIDEO_PROCESSING_REQUESTED");
    await sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeout,
      }),
    );
  }
}

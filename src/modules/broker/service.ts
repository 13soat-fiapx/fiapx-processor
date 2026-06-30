import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { sqsClient } from "../../shared/aws";
import { resolveQueueUrl } from "../../shared/utils/queue-url-resolver";
import type { BrokerModel } from "./model";
import type { QueueMessage, VideoProcessingMessage } from "./types";

function parseVideoProcessingMessage(body: string | undefined): VideoProcessingMessage {
  if (!body) {
    throw new Error("SQS message body is empty");
  }

  const payload = JSON.parse(body) as Partial<VideoProcessingMessage>;

  if (!payload.videoId || !payload.key) {
    throw new Error("SQS message body must include videoId and key");
  }

  return {
    videoId: payload.videoId,
    bucket: payload.bucket,
    key: payload.key,
  };
}

export abstract class Broker {
  static async sendFrame({ videoId }: BrokerModel["brokerRequest"]) {
    console.log({ videoId }, "received manual frame processing request");
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
}

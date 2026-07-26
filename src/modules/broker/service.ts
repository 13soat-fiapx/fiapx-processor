import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { randomBytes, randomUUID } from "node:crypto";
import { getQueueNameForTelemetry } from "../../config";
import { sqsClient } from "../../shared/aws";
import { logger } from "../../shared/observability/logger";
import {
  currentTraceparent,
  startProducerSpan,
  withSpan,
} from "../../shared/observability/message-tracing";
import { resolveQueueUrl } from "../../shared/utils/queue-url-resolver";
import type { BrokerModel } from "./model";
import type {
  EventHeaders,
  QueueMessage,
  VideoProcessingCompletedEvent,
  VideoProcessingCompletedMessage,
  VideoProcessingEvent,
  VideoProcessingMessage,
} from "./types";

function parseVideoProcessingEvent(body: string | undefined): {
  payload: VideoProcessingMessage;
  headers?: EventHeaders;
} {
  if (!body) {
    throw new Error("SQS message body is empty");
  }

  const message = JSON.parse(body.replace(/^\uFEFF/, "")) as Partial<VideoProcessingEvent>;
  const payload = message.payload;

  if (!payload) {
    throw new Error("SQS message body must include payload");
  }

  if (!payload.processingJobId || !payload.userId || !payload.inputFile?.key) {
    throw new Error("SQS message body must include processingJobId, userId and inputFile.key");
  }

  return {
    headers: message.headers,
    payload: {
      processingJobId: payload.processingJobId,
      userId: payload.userId,
      inputFile: payload.inputFile,
      outputPrefix: payload.outputPrefix,
      requestedAt: payload.requestedAt,
    },
  };
}

function createTraceparent() {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

function buildVideoProcessingEvent(payload: VideoProcessingMessage): VideoProcessingEvent {
  const occurredAt = new Date().toISOString();

  return {
    headers: {
      eventId: randomUUID(),
      eventType: "video.processing.requested",
      eventVersion: "1.0",
      traceparent: createTraceparent(),
      occurredAt,
      source: "fiapx-video-processor",
    },
    payload: {
      ...payload,
      requestedAt: payload.requestedAt ?? occurredAt,
    },
  };
}

/**
 * Three-level fallback, in order:
 *
 * 1. inject the active context — gives the notifier the processor's span as parent, which is
 *    the correct W3C waterfall and what the .NET publisher does;
 * 2. copy the incoming header — with observability disabled there is no SDK registered and
 *    `inject` writes nothing, so without this the envelope would ship with no traceparent;
 * 3. generate a fresh one — no active span and no incoming header.
 */
export function buildVideoProcessingCompletedEvent(
  payload: VideoProcessingCompletedMessage,
  sourceHeaders?: EventHeaders,
): VideoProcessingCompletedEvent {
  const occurredAt = new Date().toISOString();

  return {
    headers: {
      eventId: randomUUID(),
      eventType: "video.processing.completed",
      eventVersion: "1.0",
      traceparent: currentTraceparent() ?? sourceHeaders?.traceparent ?? createTraceparent(),
      tracestate: sourceHeaders?.tracestate,
      baggage: sourceHeaders?.baggage,
      occurredAt,
      source: "fiapx-processor",
    },
    payload,
  };
}

export abstract class Broker {
  static async sendFrame(payload: BrokerModel["brokerRequest"]) {
    const queueUrl = await resolveQueueUrl("VIDEO_PROCESSING_REQUESTED");
    const span = startProducerSpan(getQueueNameForTelemetry("VIDEO_PROCESSING_REQUESTED"));
    span.setAttribute("video.id", payload.processingJobId);

    try {
      await withSpan(span, async () => {
        const event = buildVideoProcessingEvent(payload);

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(event),
          }),
        );
      });
    } finally {
      span.end();
    }

    logger.info(
      {
        processingJobId: payload.processingJobId,
        userId: payload.userId,
      },
      "video processing request published",
    );
  }

  static async sendProcessingCompleted(
    payload: VideoProcessingCompletedMessage,
    sourceHeaders?: EventHeaders,
  ) {
    const queueUrl = await resolveQueueUrl("VIDEO_PROCESSING_COMPLETED");
    const span = startProducerSpan(getQueueNameForTelemetry("VIDEO_PROCESSING_COMPLETED"));
    span.setAttribute("video.id", payload.processingJobId);

    try {
      // The event is built inside the span so the injected traceparent points at it.
      await withSpan(span, async () => {
        const event = buildVideoProcessingCompletedEvent(payload, sourceHeaders);

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(event),
          }),
        );
      });
    } finally {
      span.end();
    }

    logger.info(
      {
        processingJobId: payload.processingJobId,
        userId: payload.user.id,
        status: payload.status,
      },
      "video processing completion published",
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

    const event = parseVideoProcessingEvent(message.Body);

    return {
      body: event.payload,
      headers: event.headers,
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

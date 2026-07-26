import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Broker } from "../../../src/modules/broker/service";
import { sqsClient } from "../../../src/shared/aws";
import { resetQueueUrlCache } from "../../../src/shared/utils/queue-url-resolver";

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/requested";
const REQUESTED_QUEUE_NAME = "fiapx-dev-video-processing-requested";

const payload = {
  processingJobId: "job-123",
  userId: "user-456",
  inputFile: {
    bucket: "fiapx-dev-artifacts-000000000000",
    key: "videos/job-123/original.mp4",
    region: "us-east-1",
  },
  outputPrefix: "frames/job-123/",
  requestedAt: "2026-07-25T12:00:00.000Z",
};

const headers = {
  eventId: "event-123",
  eventType: "video.processing.requested",
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
};

let send: ReturnType<typeof spyOn<typeof sqsClient, "send">>;

/** Answers the queue-URL lookup, then hands `response` to every other command. */
function respondWith(response: unknown) {
  send.mockImplementation((async (command: unknown) => {
    if (command instanceof GetQueueUrlCommand) return { QueueUrl: QUEUE_URL };
    return response;
  }) as typeof sqsClient.send);
}

/** Wraps `body` in the single-message shape `ReceiveMessage` returns. */
function receivedMessage(body: string | undefined) {
  respondWith({
    Messages: [{ Body: body, ReceiptHandle: "receipt-handle", MessageId: "message-123" }],
  });
}

function sentCommand<T>(type: new (...args: never[]) => T): T | undefined {
  return send.mock.calls
    .map(([call]) => call as unknown)
    .find((call): call is T => call instanceof type);
}

beforeEach(() => {
  process.env.SQS_QUEUE_NAMES_VIDEO_PROCESSING_REQUESTED = REQUESTED_QUEUE_NAME;

  // The resolver memoizes queue URLs in a module-global Map and Bun runs the whole suite in one
  // process, so without this the URL another file stubbed leaks in and the file order decides
  // whether this one passes.
  resetQueueUrlCache();

  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});

  send = spyOn(sqsClient, "send").mockImplementation((async (command: unknown) => {
    if (command instanceof GetQueueUrlCommand) return { QueueUrl: QUEUE_URL };
    return {};
  }) as typeof sqsClient.send);
});

afterEach(() => {
  delete process.env.SQS_QUEUE_NAMES_VIDEO_PROCESSING_REQUESTED;
  mock.restore();
});

describe("Broker.receiveVideoMessage", () => {
  test("long-polls a single message with the processing visibility timeout", async () => {
    respondWith({ Messages: [] });

    await Broker.receiveVideoMessage();

    expect(sentCommand(ReceiveMessageCommand)?.input).toMatchObject({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 300,
    });
  });

  test("returns the payload, headers and receipt of a valid envelope", async () => {
    receivedMessage(JSON.stringify({ headers, payload }));

    expect(await Broker.receiveVideoMessage()).toEqual({
      body: payload,
      headers,
      receiptHandle: "receipt-handle",
      messageId: "message-123",
    });
  });

  test.each([
    ["the queue is empty", { Messages: [] }],
    ["the response carries no Messages", {}],
  ])("returns null when %s", async (_label, response) => {
    respondWith(response);

    expect(await Broker.receiveVideoMessage()).toBeNull();
  });

  test("returns null when the message has no receipt handle", async () => {
    respondWith({ Messages: [{ Body: JSON.stringify({ headers, payload }) }] });

    expect(await Broker.receiveVideoMessage()).toBeNull();
  });

  // A BOM ahead of the JSON would otherwise blow up `JSON.parse`.
  test("strips a leading BOM before parsing", async () => {
    receivedMessage(`﻿${JSON.stringify({ headers, payload })}`);

    expect((await Broker.receiveVideoMessage())?.body.processingJobId).toBe("job-123");
  });

  test("projects only the five known payload fields, dropping extras", async () => {
    receivedMessage(
      JSON.stringify({
        headers,
        payload: { ...payload, description: "ignored", author: "ignored", clientReference: "x" },
      }),
    );

    expect(Object.keys((await Broker.receiveVideoMessage())?.body ?? {}).sort()).toEqual([
      "inputFile",
      "outputPrefix",
      "processingJobId",
      "requestedAt",
      "userId",
    ]);
  });

  test("returns undefined headers when the envelope carries none", async () => {
    receivedMessage(JSON.stringify({ payload }));

    expect((await Broker.receiveVideoMessage())?.headers).toBeUndefined();
  });

  test("throws when the message body is empty", async () => {
    receivedMessage(undefined);

    await expect(Broker.receiveVideoMessage()).rejects.toThrow("SQS message body is empty");
  });

  test("throws when the envelope has no payload", async () => {
    receivedMessage(JSON.stringify({ headers }));

    await expect(Broker.receiveVideoMessage()).rejects.toThrow(
      "SQS message body must include payload",
    );
  });

  test.each([
    ["processingJobId", { ...payload, processingJobId: undefined }],
    ["userId", { ...payload, userId: undefined }],
    ["inputFile.key", { ...payload, inputFile: { bucket: "b", region: "r" } }],
    ["inputFile", { ...payload, inputFile: undefined }],
  ])("throws when %s is missing", async (_label, brokenPayload) => {
    receivedMessage(JSON.stringify({ headers, payload: brokenPayload }));

    await expect(Broker.receiveVideoMessage()).rejects.toThrow(
      "SQS message body must include processingJobId, userId and inputFile.key",
    );
  });
});

describe("Broker.deleteVideoMessage", () => {
  test("deletes the message from the requested queue", async () => {
    await Broker.deleteVideoMessage("receipt-handle");

    expect(sentCommand(DeleteMessageCommand)?.input).toEqual({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: "receipt-handle",
    });
  });
});

describe("Broker.extendVideoMessageVisibility", () => {
  test("extends the visibility with the supplied timeout", async () => {
    await Broker.extendVideoMessageVisibility("receipt-handle", 60);

    expect(sentCommand(ChangeMessageVisibilityCommand)?.input).toEqual({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: "receipt-handle",
      VisibilityTimeout: 60,
    });
  });

  test("defaults to the 300s processing window", async () => {
    await Broker.extendVideoMessageVisibility("receipt-handle");

    expect(sentCommand(ChangeMessageVisibilityCommand)?.input.VisibilityTimeout).toBe(300);
  });
});

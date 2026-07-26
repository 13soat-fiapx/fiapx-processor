import {
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ProcessingJobRepository } from "../../../src/modules/processing-jobs/repository";
import type { ProcessingJobResultFile } from "../../../src/modules/processing-jobs/types";
import { dynamoDbClient } from "../../../src/shared/aws";

const JOB_ID = "job-123";

const resultFile: ProcessingJobResultFile = {
  id: "result-789",
  bucket: "fiapx-dev-artifacts-000000000000",
  key: "frames/job-123/frames.zip",
  region: "us-east-1",
  sizeBytes: 2048,
  checksum: "abc123",
};

/** The five attributes `toProcessingJob` refuses to map without. */
const requiredItem: Record<string, AttributeValue> = {
  id: { S: JOB_ID },
  userId: { S: "user-456" },
  userName: { S: "Ada Lovelace" },
  userEmail: { S: "ada@example.com" },
  status: { S: "processing" },
};

let send: ReturnType<typeof spyOn<typeof dynamoDbClient, "send">>;

/** Replies to every command with `response`, whatever the command is. */
function respondWith(response: unknown) {
  send.mockImplementation((async () => response) as typeof dynamoDbClient.send);
}

function sentCommand<T>(type: new (...args: never[]) => T): T | undefined {
  return send.mock.calls
    .map(([call]) => call as unknown)
    .find((call): call is T => call instanceof type);
}

/** The `UpdateItemCommand` input, which every `updateStatus` assertion reads. */
function updateInput() {
  const command = sentCommand(UpdateItemCommand);

  if (!command) throw new Error("no UpdateItemCommand was sent");

  return command.input;
}

/** Reads back the messages appended by an `updateStatus` call. */
function appendedMessages() {
  return (updateInput().ExpressionAttributeValues?.[":messages"]?.L ?? []).map(
    (entry) => entry.M as Record<string, AttributeValue>,
  );
}

beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});

  // Deliberately empty: the `updateStatus` happy paths override this with `{ Attributes: … }`,
  // and the bare default is exactly what the "not returned after status update" test needs.
  send = spyOn(dynamoDbClient, "send").mockImplementation(
    (async () => ({})) as typeof dynamoDbClient.send,
  );
});

afterEach(() => {
  mock.restore();
});

describe("ProcessingJobRepository.findById", () => {
  test("queries the configured table by hash key", async () => {
    respondWith({ Item: requiredItem });

    await ProcessingJobRepository.findById(JOB_ID);

    expect(sentCommand(GetItemCommand)?.input.Key).toEqual({ id: { S: JOB_ID } });
    expect(sentCommand(GetItemCommand)?.input.TableName).toBeTruthy();
  });

  test("returns null when the item does not exist", async () => {
    respondWith({});

    expect(await ProcessingJobRepository.findById(JOB_ID)).toBeNull();
  });

  test("maps a fully populated item", async () => {
    respondWith({
      Item: {
        ...requiredItem,
        status: { S: "succeeded" },
        resultFileId: { S: "result-789" },
        resultFile: {
          M: {
            Bucket: { S: resultFile.bucket },
            Key: { S: resultFile.key },
            Region: { S: resultFile.region },
          },
        },
        resultSizeBytes: { N: "2048" },
        resultChecksum: { S: "abc123" },
        errorMessage: { S: "none" },
        createdAt: { S: "2026-07-25T12:00:00.000Z" },
        updatedAt: { S: "2026-07-25T12:05:00.000Z" },
        completedAt: { S: "2026-07-25T12:10:00.000Z" },
      },
    });

    expect(await ProcessingJobRepository.findById(JOB_ID)).toEqual({
      id: JOB_ID,
      userId: "user-456",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      status: "succeeded",
      resultFileId: "result-789",
      resultFile: {
        bucket: resultFile.bucket,
        key: resultFile.key,
        region: resultFile.region,
      },
      resultSizeBytes: 2048,
      resultChecksum: "abc123",
      messages: [],
      errorMessage: "none",
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:05:00.000Z",
      completedAt: "2026-07-25T12:10:00.000Z",
    });
  });

  test.each(["id", "userId", "userName", "userEmail", "status"])(
    "throws when %s is missing",
    async (missing) => {
      const item = { ...requiredItem };
      delete item[missing];
      respondWith({ Item: item });

      await expect(ProcessingJobRepository.findById(JOB_ID)).rejects.toThrow(
        "Processing job item is missing id, userId, userName, userEmail or status",
      );
    },
  );
});

// The API writes these maps in PascalCase; older records use camelCase. Both must read back.
describe("ProcessingJobRepository.findById result file mapping", () => {
  test.each([
    ["PascalCase", { Bucket: { S: "b" }, Key: { S: "k" }, Region: { S: "r" } }],
    ["camelCase", { bucket: { S: "b" }, key: { S: "k" }, region: { S: "r" } }],
  ])("maps a %s result file", async (_label, map) => {
    respondWith({ Item: { ...requiredItem, resultFile: { M: map } } });

    const job = await ProcessingJobRepository.findById(JOB_ID);

    expect(job?.resultFile).toEqual({ bucket: "b", key: "k", region: "r" });
  });

  test("returns undefined when the map is incomplete", async () => {
    respondWith({
      Item: { ...requiredItem, resultFile: { M: { Bucket: { S: "b" }, Key: { S: "k" } } } },
    });

    expect((await ProcessingJobRepository.findById(JOB_ID))?.resultFile).toBeUndefined();
  });

  test("returns undefined when the attribute is not a map", async () => {
    respondWith({ Item: { ...requiredItem, resultFile: { S: "not-a-map" } } });

    expect((await ProcessingJobRepository.findById(JOB_ID))?.resultFile).toBeUndefined();
  });

  test("converts a numeric resultSizeBytes", async () => {
    respondWith({ Item: { ...requiredItem, resultSizeBytes: { N: "4096" } } });

    expect((await ProcessingJobRepository.findById(JOB_ID))?.resultSizeBytes).toBe(4096);
  });

  test.each([
    ["non-finite", { N: "not-a-number" }],
    ["not a number attribute", { S: "2048" }],
  ])("returns undefined for a %s resultSizeBytes", async (_label, value) => {
    respondWith({ Item: { ...requiredItem, resultSizeBytes: value } });

    expect((await ProcessingJobRepository.findById(JOB_ID))?.resultSizeBytes).toBeUndefined();
  });
});

describe("ProcessingJobRepository.findById message mapping", () => {
  test.each([
    [
      "PascalCase",
      {
        Code: { S: "PROC-0003" },
        Message: { S: "Processing started." },
        Severity: { S: "info" },
        CreatedAt: { S: "2026-07-25T12:00:00.000Z" },
      },
    ],
    [
      "camelCase",
      {
        code: { S: "PROC-0003" },
        message: { S: "Processing started." },
        severity: { S: "info" },
        createdAt: { S: "2026-07-25T12:00:00.000Z" },
      },
    ],
  ])("maps a %s message preserving createdAt", async (_label, entry) => {
    respondWith({ Item: { ...requiredItem, messages: { L: [{ M: entry }] } } });

    expect((await ProcessingJobRepository.findById(JOB_ID))?.messages).toEqual([
      {
        code: "PROC-0003",
        message: "Processing started.",
        severity: "info",
        createdAt: "2026-07-25T12:00:00.000Z",
      },
    ]);
  });

  test("leaves createdAt undefined when the entry omits it", async () => {
    respondWith({
      Item: {
        ...requiredItem,
        messages: {
          L: [{ M: { Code: { S: "PROC-1000" }, Message: { S: "ok" }, Severity: { S: "info" } } }],
        },
      },
    });

    const [message] = (await ProcessingJobRepository.findById(JOB_ID))?.messages ?? [];

    expect(message?.createdAt).toBeUndefined();
  });

  test("silently drops malformed entries and keeps the valid ones", async () => {
    respondWith({
      Item: {
        ...requiredItem,
        messages: {
          L: [
            { S: "not-a-map" },
            { M: { Message: { S: "no code" }, Severity: { S: "info" } } },
            { M: { Code: { S: "PROC-1" }, Severity: { S: "info" } } },
            { M: { Code: { S: "PROC-2" }, Message: { S: "no severity" } } },
            { M: { Code: { S: "PROC-3" }, Message: { S: "kept" }, Severity: { S: "info" } } },
          ],
        },
      },
    });

    const messages = (await ProcessingJobRepository.findById(JOB_ID))?.messages;

    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.code).toBe("PROC-3");
  });

  test.each([
    ["the attribute is absent", undefined],
    ["the attribute is not a list", { S: "not-a-list" } as AttributeValue],
  ])("returns an empty array when %s", async (_label, messages) => {
    respondWith({ Item: messages ? { ...requiredItem, messages } : { ...requiredItem } });

    expect((await ProcessingJobRepository.findById(JOB_ID))?.messages).toEqual([]);
  });
});

describe("ProcessingJobRepository.updateStatus", () => {
  beforeEach(() => {
    respondWith({ Attributes: requiredItem });
  });

  test("guards every update with attribute_exists and returns the new image", async () => {
    await ProcessingJobRepository.updateStatus({ processingJobId: JOB_ID, status: "processing" });

    expect(updateInput().ConditionExpression).toBe("attribute_exists(id)");
    expect(updateInput().ReturnValues).toBe("ALL_NEW");
    expect(updateInput().Key).toEqual({ id: { S: JOB_ID } });
  });

  test("always writes status and updatedAt", async () => {
    await ProcessingJobRepository.updateStatus({ processingJobId: JOB_ID, status: "processing" });

    expect(updateInput().ExpressionAttributeValues?.[":status"]).toEqual({ S: "processing" });
    expect(updateInput().ExpressionAttributeValues?.[":updatedAt"]?.S).toBeString();
    expect(updateInput().UpdateExpression).toStartWith("SET #status = :status, #updatedAt = :updatedAt");
  });

  test("appends messages instead of overwriting them", async () => {
    await ProcessingJobRepository.updateStatus({ processingJobId: JOB_ID, status: "processing" });

    expect(updateInput().UpdateExpression).toContain(
      "#messages = list_append(if_not_exists(#messages, :emptyMessages), :messages)",
    );
    expect(updateInput().ExpressionAttributeValues?.[":emptyMessages"]).toEqual({ L: [] });
  });

  test("resets the progress and logs PROC-0003 when moving to processing", async () => {
    await ProcessingJobRepository.updateStatus({ processingJobId: JOB_ID, status: "processing" });

    expect(updateInput().ExpressionAttributeValues?.[":progressPercentage"]).toEqual({ N: "0" });
    expect(appendedMessages()).toEqual([
      {
        Code: { S: "PROC-0003" },
        Message: { S: "Processing started." },
        Severity: { S: "info" },
        CreatedAt: { S: expect.any(String) },
      },
    ]);
  });

  test("writes the six result attributes and logs PROC-1000 when succeeding", async () => {
    await ProcessingJobRepository.updateStatus({
      processingJobId: JOB_ID,
      status: "succeeded",
      resultFile,
    });

    const values = updateInput().ExpressionAttributeValues ?? {};

    expect(values[":progressPercentage"]).toEqual({ N: "100" });
    expect(values[":completedAt"]?.S).toBeString();
    expect(values[":resultFileId"]).toEqual({ S: resultFile.id });
    expect(values[":resultFile"]).toEqual({
      M: {
        Bucket: { S: resultFile.bucket },
        Key: { S: resultFile.key },
        Region: { S: resultFile.region },
      },
    });
    expect(values[":resultSizeBytes"]).toEqual({ N: "2048" });
    expect(values[":resultChecksum"]).toEqual({ S: "abc123" });
    expect(appendedMessages()[0]?.Code).toEqual({ S: "PROC-1000" });
  });

  test("refuses to complete a job without result file metadata", async () => {
    await expect(
      ProcessingJobRepository.updateStatus({ processingJobId: JOB_ID, status: "succeeded" }),
    ).rejects.toThrow("Result file metadata is required when completing a processing job.");

    expect(sentCommand(UpdateItemCommand)).toBeUndefined();
  });

  test("stamps completedAt and logs PROC-9000 with the error when failing", async () => {
    await ProcessingJobRepository.updateStatus({
      processingJobId: JOB_ID,
      status: "failed",
      errorMessage: "ffmpeg failed",
    });

    expect(updateInput().ExpressionAttributeValues?.[":completedAt"]?.S).toBeString();
    expect(appendedMessages()).toEqual([
      {
        Code: { S: "PROC-9000" },
        Message: { S: "ffmpeg failed" },
        Severity: { S: "error" },
        CreatedAt: { S: expect.any(String) },
      },
    ]);
  });

  test("falls back to a generic message when the failure has no description", async () => {
    await ProcessingJobRepository.updateStatus({ processingJobId: JOB_ID, status: "failed" });

    expect(appendedMessages()[0]?.Message).toEqual({ S: "Video processing failed." });
  });

  // `queued` and `upload_pending` take none of the three branches, so nothing is appended.
  test("appends no message for a status without a branch", async () => {
    await ProcessingJobRepository.updateStatus({ processingJobId: JOB_ID, status: "queued" });

    expect(updateInput().UpdateExpression).not.toContain("list_append");
    expect(updateInput().ExpressionAttributeValues?.[":messages"]).toBeUndefined();
  });

  test("throws when DynamoDB returns no attributes", async () => {
    respondWith({});

    await expect(
      ProcessingJobRepository.updateStatus({ processingJobId: JOB_ID, status: "processing" }),
    ).rejects.toThrow(`Processing job '${JOB_ID}' was not returned after status update.`);
  });

  test("returns the mapped job built from the new image", async () => {
    respondWith({ Attributes: { ...requiredItem, status: { S: "succeeded" } } });

    const job = await ProcessingJobRepository.updateStatus({
      processingJobId: JOB_ID,
      status: "succeeded",
      resultFile,
    });

    expect(job.id).toBe(JOB_ID);
    expect(job.status).toBe("succeeded");
  });
});

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runWorker } from "../../src/worker";
import {
  createWorkerDependencies,
  mockProcessingJob,
  mockQueueMessage,
  mockResultFile,
} from "../mocks/worker";

beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
});

describe("worker integration", () => {
  test("processes a queued video through status updates, completion publishing, and message deletion", async () => {
    const calls: string[] = [];
    const dependencies = createWorkerDependencies({
      updateStatus: mock(async ({ status, resultFile }) => {
        calls.push(`status:${status}`);
        return {
          ...mockProcessingJob,
          status,
          resultFile,
          completedAt: status === "succeeded" ? mockProcessingJob.completedAt : undefined,
        };
      }),
      processVideo: mock(async () => {
        calls.push("processVideo");
        return mockResultFile;
      }),
      sendProcessingCompleted: mock(async () => {
        calls.push("publishCompletion");
      }),
    });

    dependencies.broker.deleteVideoMessage.mockImplementation(async () => {
      calls.push("deleteMessage");
    });

    await runWorker(dependencies);

    expect(calls).toEqual([
      "status:processing",
      "processVideo",
      "status:succeeded",
      "publishCompletion",
      "deleteMessage",
    ]);
    expect(dependencies.broker.sendProcessingCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        processingJobId: "job-123",
        status: "succeeded",
        result: expect.objectContaining({
          sizeBytes: mockResultFile.sizeBytes,
          checksum: mockResultFile.checksum,
        }),
      }),
      mockQueueMessage.headers,
    );
  });

  test("publishes a failed completion event when video processing throws", async () => {
    const dependencies = createWorkerDependencies({
      processVideo: mock(async () => {
        throw new Error("ffmpeg failed");
      }),
    });

    await runWorker(dependencies);

    expect(dependencies.processingJobService.updateStatus).toHaveBeenNthCalledWith(2, {
      processingJobId: "job-123",
      status: "failed",
      errorMessage: "ffmpeg failed",
    });
    expect(dependencies.broker.sendProcessingCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        processingJobId: "job-123",
        status: "failed",
        result: undefined,
      }),
      mockQueueMessage.headers,
    );
    expect(dependencies.broker.deleteVideoMessage).toHaveBeenCalledWith("receipt-handle");
  });
});

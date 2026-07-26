import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { buildCompletedMessage, runWorker, startVisibilityHeartbeat } from "../../src/worker";
import {
  createWorkerDependencies,
  createWorkerDependenciesWithPublishFailure,
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

describe("buildCompletedMessage", () => {
  test("builds a succeeded completion payload with result file details", () => {
    expect(buildCompletedMessage(mockProcessingJob, "succeeded", mockResultFile)).toEqual({
      processingJobId: "job-123",
      user: {
        id: "user-456",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
      status: "succeeded",
      messages: [
        {
          code: "FRAME_EXTRACTION_STARTED",
          message: "Frame extraction started",
          severity: "info",
        },
      ],
      result: {
        zipFile: {
          bucket: "video-results",
          key: "frames/job-123/frames.zip",
          region: "us-east-1",
        },
        sizeBytes: 2048,
        checksum: "abc123",
      },
      completedAt: "2026-07-25T12:10:00.000Z",
    });
  });

  test("builds a failed completion payload without a result", () => {
    const payload = buildCompletedMessage(mockProcessingJob, "failed");

    expect(payload.status).toBe("failed");
    expect(payload.result).toBeUndefined();
    expect(payload.completedAt).toBe("2026-07-25T12:10:00.000Z");
  });
});

describe("startVisibilityHeartbeat", () => {
  const TICK_MS = 5;

  /** Waits long enough for `ticks` heartbeat intervals to fire. */
  function waitForTicks(ticks: number) {
    return new Promise((resolve) => setTimeout(resolve, TICK_MS * ticks + TICK_MS));
  }

  test("keeps extending the message visibility while the job runs", async () => {
    const extendVideoMessageVisibility = mock(async () => {});
    const stop = startVisibilityHeartbeat(
      "receipt-handle",
      "message-123",
      { extendVideoMessageVisibility } as never,
      TICK_MS,
    );

    try {
      await waitForTicks(2);
    } finally {
      stop();
    }

    expect(extendVideoMessageVisibility).toHaveBeenCalledWith("receipt-handle", 300);
    expect(extendVideoMessageVisibility.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("stops extending once the returned closure is called", async () => {
    const extendVideoMessageVisibility = mock(async () => {});
    const stop = startVisibilityHeartbeat(
      "receipt-handle",
      "message-123",
      { extendVideoMessageVisibility } as never,
      TICK_MS,
    );

    await waitForTicks(2);
    stop();
    const afterStop = extendVideoMessageVisibility.mock.calls.length;
    await waitForTicks(3);

    expect(extendVideoMessageVisibility.mock.calls.length).toBe(afterStop);
  });

  // An expired receipt handle must not take the whole job down mid-processing.
  test("swallows an extension failure instead of breaking processing", async () => {
    const extendVideoMessageVisibility = mock(async () => {
      throw new Error("ReceiptHandleIsInvalid");
    });
    const stop = startVisibilityHeartbeat(
      "receipt-handle",
      "message-123",
      { extendVideoMessageVisibility } as never,
      TICK_MS,
    );

    try {
      await waitForTicks(2);
    } finally {
      stop();
    }

    expect(extendVideoMessageVisibility).toHaveBeenCalled();
  });
});

describe("runWorker", () => {
  test("returns without processing when no queue message is available", async () => {
    const dependencies = createWorkerDependencies({ message: null });

    await runWorker(dependencies);

    expect(dependencies.broker.receiveVideoMessage).toHaveBeenCalledTimes(1);
    expect(dependencies.processingJobService.updateStatus).not.toHaveBeenCalled();
    expect(dependencies.processVideo).not.toHaveBeenCalled();
    expect(dependencies.broker.sendProcessingCompleted).not.toHaveBeenCalled();
    expect(dependencies.broker.deleteVideoMessage).not.toHaveBeenCalled();
  });

  test("marks the job as succeeded, publishes completion, and deletes the SQS message", async () => {
    const dependencies = createWorkerDependencies();

    await runWorker(dependencies);

    expect(dependencies.processingJobService.updateStatus).toHaveBeenNthCalledWith(1, {
      processingJobId: "job-123",
      status: "processing",
    });
    expect(dependencies.processVideo).toHaveBeenCalledWith(mockQueueMessage.body);
    expect(dependencies.processingJobService.updateStatus).toHaveBeenNthCalledWith(2, {
      processingJobId: "job-123",
      status: "succeeded",
      resultFile: mockResultFile,
    });
    expect(dependencies.broker.sendProcessingCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        processingJobId: "job-123",
        status: "succeeded",
        result: expect.objectContaining({
          zipFile: {
            bucket: "video-results",
            key: "frames/job-123/frames.zip",
            region: "us-east-1",
          },
        }),
      }),
      mockQueueMessage.headers,
    );
    expect(dependencies.broker.deleteVideoMessage).toHaveBeenCalledWith("receipt-handle");
  });

  test("marks the job as failed, publishes failure, and deletes the SQS message when processing fails", async () => {
    const processVideo = mock(async () => {
      throw new Error("ffmpeg failed");
    });
    const dependencies = createWorkerDependencies({ processVideo });

    await runWorker(dependencies);

    expect(dependencies.processingJobService.updateStatus).toHaveBeenNthCalledWith(1, {
      processingJobId: "job-123",
      status: "processing",
    });
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

  test("does not delete the SQS message if publishing completion fails after the job succeeds", async () => {
    const dependencies = createWorkerDependenciesWithPublishFailure();

    await expect(runWorker(dependencies)).rejects.toThrow("publish failed");

    expect(dependencies.processingJobService.updateStatus).toHaveBeenNthCalledWith(2, {
      processingJobId: "job-123",
      status: "succeeded",
      resultFile: mockResultFile,
    });
    expect(dependencies.broker.deleteVideoMessage).not.toHaveBeenCalled();
  });
});

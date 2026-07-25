import { mock } from "bun:test";
import type { QueueMessage } from "../../src/modules/broker/types";
import type {
  ProcessingJob,
  ProcessingJobResultFile,
} from "../../src/modules/processing-jobs/types";
import type { WorkerDependencies } from "../../src/worker";

type MockFunction = ReturnType<typeof mock>;

export type MockWorkerDependencies = WorkerDependencies & {
  broker: {
    receiveVideoMessage: MockFunction;
    extendVideoMessageVisibility: MockFunction;
    sendProcessingCompleted: MockFunction;
    deleteVideoMessage: MockFunction;
  };
  processingJobService: {
    updateStatus: MockFunction;
  };
  processVideo: MockFunction;
};

export const mockProcessingJob: ProcessingJob = {
  id: "job-123",
  userId: "user-456",
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  status: "processing",
  messages: [
    {
      code: "FRAME_EXTRACTION_STARTED",
      message: "Frame extraction started",
      severity: "info",
      createdAt: "2026-07-25T12:00:00.000Z",
    },
  ],
  completedAt: "2026-07-25T12:10:00.000Z",
};

export const mockResultFile: ProcessingJobResultFile = {
  id: "result-789",
  bucket: "video-results",
  key: "frames/job-123/frames.zip",
  region: "us-east-1",
  sizeBytes: 2048,
  checksum: "abc123",
};

export const mockQueueMessage: QueueMessage = {
  receiptHandle: "receipt-handle",
  messageId: "message-123",
  headers: {
    eventId: "event-123",
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  },
  body: {
    processingJobId: "job-123",
    userId: "user-456",
    inputFile: {
      bucket: "video-inputs",
      key: "uploads/input.mp4",
      region: "us-east-1",
    },
    outputPrefix: "frames/job-123",
  },
};

export function createWorkerDependencies({
  message = mockQueueMessage,
  updateStatus,
  processVideo = mock(async () => mockResultFile),
  sendProcessingCompleted = mock(async () => {}),
}: {
  message?: QueueMessage | null;
  updateStatus?: MockFunction;
  processVideo?: MockFunction;
  sendProcessingCompleted?: MockFunction;
} = {}): MockWorkerDependencies {
  return {
    broker: {
      receiveVideoMessage: mock(async () => message),
      extendVideoMessageVisibility: mock(async () => {}),
      sendProcessingCompleted,
      deleteVideoMessage: mock(async () => {}),
    },
    processingJobService: {
      updateStatus:
        updateStatus ??
        mock(async ({ status }) => ({
          ...mockProcessingJob,
          status,
          completedAt: status === "succeeded" ? mockProcessingJob.completedAt : undefined,
        })),
    },
    processVideo,
  };
}

export function createWorkerDependenciesWithPublishFailure(
  error: Error = new Error("publish failed"),
) {
  return createWorkerDependencies({
    sendProcessingCompleted: mock(async () => {
      throw error;
    }),
  });
}

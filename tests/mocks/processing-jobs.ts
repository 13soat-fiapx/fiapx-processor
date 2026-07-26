import type { ProcessingJobService } from "../../src/modules/processing-jobs/service";

type JobStatus = NonNullable<Awaited<ReturnType<typeof ProcessingJobService.getStatus>>>;

/**
 * Shaped after `ProcessingJobService.getStatus`, not after `ProcessingJob`: the route declares
 * `200: ProcessingJobModel.partialStatus` and Elysia validates responses, so a repository-shaped
 * object (with `id` instead of `processingJobId`) fails validation instead of the assertion.
 */
export const mockJobStatus: JobStatus = {
  processingJobId: "job-123",
  userId: "user-456",
  userName: "Ada Lovelace",
  userEmail: "ada@example.com",
  status: "processing",
  resultFileId: undefined,
  resultFile: undefined,
  messages: [
    {
      code: "PROC-0003",
      message: "Processing started.",
      severity: "info",
      createdAt: "2026-07-25T12:00:00.000Z",
    },
  ],
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:05:00.000Z",
};

export function buildJobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return { ...mockJobStatus, ...overrides };
}

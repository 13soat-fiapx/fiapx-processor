import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ProcessingJobRepository } from "../../../src/modules/processing-jobs/repository";
import { ProcessingJobService } from "../../../src/modules/processing-jobs/service";
import type { ProcessingJob } from "../../../src/modules/processing-jobs/types";
import { mockProcessingJob, mockResultFile } from "../../mocks/worker";

const storedJob: ProcessingJob = {
  ...mockProcessingJob,
  resultFileId: "result-789",
  resultFile: { bucket: mockResultFile.bucket, key: mockResultFile.key, region: mockResultFile.region },
  resultSizeBytes: mockResultFile.sizeBytes,
  resultChecksum: mockResultFile.checksum,
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:05:00.000Z",
};

beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
});

describe("ProcessingJobService.getStatus", () => {
  test("renames id to processingJobId and forwards the reportable fields", async () => {
    spyOn(ProcessingJobRepository, "findById").mockResolvedValue(storedJob);

    expect(await ProcessingJobService.getStatus("job-123")).toEqual({
      processingJobId: "job-123",
      userId: storedJob.userId,
      userName: storedJob.userName,
      userEmail: storedJob.userEmail,
      status: storedJob.status,
      resultFileId: "result-789",
      resultFile: storedJob.resultFile,
      messages: storedJob.messages,
      createdAt: storedJob.createdAt,
      updatedAt: storedJob.updatedAt,
    });
  });

  // The size and checksum stay internal: the status endpoint redirects to the file service.
  test("omits the internal result size and checksum", async () => {
    spyOn(ProcessingJobRepository, "findById").mockResolvedValue(storedJob);

    const status = await ProcessingJobService.getStatus("job-123");

    expect(status).not.toHaveProperty("resultSizeBytes");
    expect(status).not.toHaveProperty("resultChecksum");
  });

  test("queries the repository by the given id", async () => {
    const findById = spyOn(ProcessingJobRepository, "findById").mockResolvedValue(storedJob);

    await ProcessingJobService.getStatus("job-123");

    expect(findById).toHaveBeenCalledWith("job-123");
  });

  test("returns null when the repository finds nothing", async () => {
    spyOn(ProcessingJobRepository, "findById").mockResolvedValue(null);

    expect(await ProcessingJobService.getStatus("missing")).toBeNull();
  });
});

describe("ProcessingJobService.updateStatus", () => {
  test("delegates the input to the repository untouched", async () => {
    const updateStatus = spyOn(ProcessingJobRepository, "updateStatus").mockResolvedValue(storedJob);
    const input = {
      processingJobId: "job-123",
      status: "succeeded" as const,
      resultFile: mockResultFile,
    };

    expect(await ProcessingJobService.updateStatus(input)).toBe(storedJob);
    expect(updateStatus).toHaveBeenCalledWith(input);
  });

  test("propagates a repository failure", async () => {
    spyOn(ProcessingJobRepository, "updateStatus").mockRejectedValue(
      new Error("ConditionalCheckFailedException"),
    );

    await expect(
      ProcessingJobService.updateStatus({ processingJobId: "job-123", status: "processing" }),
    ).rejects.toThrow("ConditionalCheckFailedException");
  });
});

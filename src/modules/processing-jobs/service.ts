import { ProcessingJobRepository } from "./repository";
import type { ProcessingJobResultFile, ProcessingJobStatus } from "./types";

export abstract class ProcessingJobService {
  static async getStatus(processingJobId: string) {
    const job = await ProcessingJobRepository.findById(processingJobId);

    if (!job) return null;

    return {
      processingJobId: job.id,
      userId: job.userId,
      userName: job.userName,
      userEmail: job.userEmail,
      status: job.status,
      resultFileId: job.resultFileId,
      resultFile: job.resultFile,
      messages: job.messages,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  static async updateStatus(input: {
    processingJobId: string;
    status: ProcessingJobStatus;
    resultFile?: ProcessingJobResultFile;
    errorMessage?: string;
  }) {
    return await ProcessingJobRepository.updateStatus(input);
  }
}

import { ProcessingJobRepository } from "./repository";
import type { ProcessingJobStatus } from "./types";

export abstract class ProcessingJobService {
  static async createPending(input: {
    processingJobId: string;
    userId: string;
  }) {
    await ProcessingJobRepository.createPending(input);
  }

  static async getStatus(processingJobId: string) {
    const job = await ProcessingJobRepository.findById(processingJobId);

    if (!job) return null;

    return {
      processingJobId: job.id,
      userId: job.userId,
      status: job.status,
      outputFileKey: job.outputFileKey,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  static async updateStatus(input: {
    processingJobId: string;
    status: ProcessingJobStatus;
    outputFileKey?: string;
    errorMessage?: string;
  }) {
    await ProcessingJobRepository.updateStatus(input);
  }
}

export type ProcessingJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

export type ProcessingJob = {
  id: string;
  userId: string;
  status: ProcessingJobStatus;
  outputFileKey?: string;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
};

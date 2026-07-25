export type ProcessingJobStatus =
  | "upload_pending"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed";

export type S3ObjectReference = {
  bucket: string;
  key: string;
  region: string;
};

export type ProcessingJobResultFile = S3ObjectReference & {
  id: string;
  sizeBytes: number;
  checksum: string;
};

export type ProcessingMessage = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  createdAt?: string;
};

export type ProcessingJob = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  status: ProcessingJobStatus;
  resultFileId?: string;
  resultFile?: S3ObjectReference;
  resultSizeBytes?: number;
  resultChecksum?: string;
  messages: ProcessingMessage[];
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
};

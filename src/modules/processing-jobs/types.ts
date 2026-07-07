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

export type ProcessingJob = {
  id: string;
  userId: string;
  status: ProcessingJobStatus;
  resultFileId?: string;
  resultFile?: S3ObjectReference;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
};

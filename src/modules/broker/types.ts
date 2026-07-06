export type VideoProcessingMessage = {
  processingJobId: string;
  userId: string;
  inputFile: {
    bucket?: string;
    key: string;
    region?: string;
    originalFileName?: string;
    contentType?: string;
    sizeBytes?: number;
  };
  outputPrefix?: string;
  requestedAt?: string;
};

export type VideoProcessingEvent = {
  headers?: {
    eventId?: string;
    eventType?: string;
    eventVersion?: string;
    traceparent?: string;
    occurredAt?: string;
    source?: string;
  };
  payload: VideoProcessingMessage;
};

export type QueueMessage = {
  body: VideoProcessingMessage;
  receiptHandle: string;
  messageId?: string;
};

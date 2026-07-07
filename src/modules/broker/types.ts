export type EventHeaders = {
  eventId?: string;
  eventType?: string;
  eventVersion?: string;
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
  occurredAt?: string;
  source?: string;
};

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
  headers?: EventHeaders;
  payload: VideoProcessingMessage;
};

export type VideoProcessingCompletedMessage = {
  processingJobId: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
  status: "succeeded" | "failed";
  messages: Array<{
    code: string;
    message: string;
    severity: string;
  }>;
  result?: {
    zipFile: {
      bucket: string;
      key: string;
      region: string;
    };
    sizeBytes?: number;
    checksum?: string;
  };
  completedAt: string;
  estimatedCompletionTime?: string;
};

export type VideoProcessingCompletedEvent = {
  headers: EventHeaders;
  payload: VideoProcessingCompletedMessage;
};

export type QueueMessage = {
  body: VideoProcessingMessage;
  headers?: EventHeaders;
  receiptHandle: string;
  messageId?: string;
};

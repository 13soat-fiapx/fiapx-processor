export type VideoProcessingMessage = {
  videoId: string;
  bucket?: string;
  key: string;
};

export type QueueMessage = {
  body: VideoProcessingMessage;
  receiptHandle: string;
  messageId?: string;
};

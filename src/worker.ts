import { SpanStatusCode } from "@opentelemetry/api";
import { getQueueNameForTelemetry } from "./config";
import { Broker } from "./modules/broker/service";
import type { VideoProcessingCompletedMessage } from "./modules/broker/types";
import { ProcessingJobService } from "./modules/processing-jobs/service";
import type { ProcessingJob, ProcessingJobResultFile } from "./modules/processing-jobs/types";
import { processVideo } from "./modules/video/processor";
import { initObservability, shutdownObservability } from "./shared/observability";
import { AppMetrics, type ProcessingStatus } from "./shared/observability/app-metrics";
import { logger } from "./shared/observability/logger";
import { startConsumerSpan, withSpan } from "./shared/observability/message-tracing";

const VISIBILITY_TIMEOUT_SECONDS = 30;
const VISIBILITY_HEARTBEAT_MS = 20_000;

type WorkerBroker = Pick<
  typeof Broker,
  | "receiveVideoMessage"
  | "extendVideoMessageVisibility"
  | "sendProcessingCompleted"
  | "deleteVideoMessage"
>;
type WorkerProcessingJobService = Pick<typeof ProcessingJobService, "updateStatus">;

export type WorkerDependencies = {
  broker: WorkerBroker;
  processingJobService: WorkerProcessingJobService;
  processVideo: typeof processVideo;
};

const defaultDependencies: WorkerDependencies = {
  broker: Broker,
  processingJobService: ProcessingJobService,
  processVideo,
};

export function startVisibilityHeartbeat(
  receiptHandle: string,
  messageId?: string,
  broker: WorkerBroker = Broker,
  intervalMs: number = VISIBILITY_HEARTBEAT_MS,
) {
  const interval = setInterval(async () => {
    try {
      await broker.extendVideoMessageVisibility(receiptHandle, VISIBILITY_TIMEOUT_SECONDS);
      logger.info({ messageId }, "SQS message visibility extended");
    } catch (error) {
      logger.error({ error, messageId }, "failed to extend SQS message visibility");
    }
  }, intervalMs);

  return () => clearInterval(interval);
}

export function buildCompletedMessage(
  job: ProcessingJob,
  status: "succeeded" | "failed",
  resultFile?: ProcessingJobResultFile,
): VideoProcessingCompletedMessage {
  return {
    processingJobId: job.id,
    user: {
      id: job.userId,
      name: job.userName,
      email: job.userEmail,
    },
    status,
    messages: job.messages.map(({ code, message, severity }) => ({
      code,
      message,
      severity,
    })),
    result: resultFile
      ? {
          zipFile: {
            bucket: resultFile.bucket,
            key: resultFile.key,
            region: resultFile.region,
          },
          sizeBytes: resultFile.sizeBytes,
          checksum: resultFile.checksum,
        }
      : undefined,
    completedAt: job.completedAt ?? new Date().toISOString(),
  };
}

export async function runWorker(dependencies: WorkerDependencies = defaultDependencies) {
  const { broker, processingJobService, processVideo } = dependencies;
  const message = await broker.receiveVideoMessage();

  if (!message) {
    logger.info({}, "No message available. Worker finished without processing.");
    return;
  }

  // Continues the trace started by the API; a missing or invalid header yields a root span.
  const span = startConsumerSpan(
    getQueueNameForTelemetry("VIDEO_PROCESSING_REQUESTED"),
    message.headers?.traceparent,
  );
  span.setAttribute("video.id", message.body.processingJobId);

  const startedAt = Date.now();
  let status: ProcessingStatus = "succeeded";

  try {
    await withSpan(span, async () => {
      logger.info(
        {
          messageId: message.messageId,
          processingJobId: message.body.processingJobId,
          userId: message.body.userId,
        },
        "processing SQS message",
      );

      const stopVisibilityHeartbeat = startVisibilityHeartbeat(
        message.receiptHandle,
        message.messageId,
        broker,
      );

      let completedJob: ProcessingJob | undefined;

      try {
        await processingJobService.updateStatus({
          processingJobId: message.body.processingJobId,
          status: "processing",
        });

        const resultFile = await processVideo(message.body);

        completedJob = await processingJobService.updateStatus({
          processingJobId: message.body.processingJobId,
          status: "succeeded",
          resultFile,
        });

        await broker.sendProcessingCompleted(
          buildCompletedMessage(completedJob, "succeeded", resultFile),
          message.headers,
        );
      } catch (error) {
        status = "failed";
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });

        if (completedJob) {
          throw error;
        }

        const failedJob = await processingJobService.updateStatus({
          processingJobId: message.body.processingJobId,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        await broker.sendProcessingCompleted(
          buildCompletedMessage(failedJob, "failed"),
          message.headers,
        );
      } finally {
        stopVisibilityHeartbeat();
      }

      await broker.deleteVideoMessage(message.receiptHandle);

      logger.info(
        {
          messageId: message.messageId,
          processingJobId: message.body.processingJobId,
          userId: message.body.userId,
        },
        "SQS message processed and deleted",
      );
    });
  } finally {
    AppMetrics.recordProcessed(status);
    AppMetrics.recordProcessingDuration((Date.now() - startedAt) / 1000, status);
    span.end();
  }
}

if (import.meta.main) {
  initObservability();

  // The Job may be cut short before the work finishes; flush what has been recorded so far.
  process.on("SIGTERM", () => {
    void shutdownObservability().finally(() => process.exit(143));
  });

  let exitCode = 0;

  try {
    await runWorker();
  } catch (error) {
    logger.error({ error }, "worker failed");
    exitCode = 1;
  } finally {
    // Mandatory in the ScaledJob: the batch processors export on a timer, so exiting without
    // this discards the whole job's telemetry.
    await shutdownObservability();
  }

  process.exit(exitCode);
}

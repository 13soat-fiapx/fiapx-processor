import { Broker } from "./modules/broker/service";
import type { VideoProcessingCompletedMessage } from "./modules/broker/types";
import { ProcessingJobService } from "./modules/processing-jobs/service";
import type { ProcessingJob, ProcessingJobResultFile } from "./modules/processing-jobs/types";
import { processVideo } from "./modules/video/processor";

const VISIBILITY_TIMEOUT_SECONDS = 300;
const VISIBILITY_HEARTBEAT_MS = 20_000;

function startVisibilityHeartbeat(receiptHandle: string, messageId?: string) {
  const interval = setInterval(async () => {
    try {
      await Broker.extendVideoMessageVisibility(receiptHandle, VISIBILITY_TIMEOUT_SECONDS);
      console.log({ messageId }, "SQS message visibility extended");
    } catch (error) {
      console.error({ error, messageId }, "failed to extend SQS message visibility");
    }
  }, VISIBILITY_HEARTBEAT_MS);

  return () => clearInterval(interval);
}

function buildCompletedMessage(
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

async function main() {
  const message = await Broker.receiveVideoMessage();

  if (!message) {
    console.log("No message available. Worker finished without processing.");
    return;
  }

  console.log(
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
  );

  let completedJob: ProcessingJob | undefined;

  try {
    await ProcessingJobService.updateStatus({
      processingJobId: message.body.processingJobId,
      status: "processing",
    });

    const resultFile = await processVideo(message.body);

    completedJob = await ProcessingJobService.updateStatus({
      processingJobId: message.body.processingJobId,
      status: "succeeded",
      resultFile,
    });

    await Broker.sendProcessingCompleted(
      buildCompletedMessage(completedJob, "succeeded", resultFile),
      message.headers,
    );
  } catch (error) {
    if (completedJob) {
      throw error;
    }

    const failedJob = await ProcessingJobService.updateStatus({
      processingJobId: message.body.processingJobId,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    await Broker.sendProcessingCompleted(
      buildCompletedMessage(failedJob, "failed"),
      message.headers,
    );
  } finally {
    stopVisibilityHeartbeat();
  }

  await Broker.deleteVideoMessage(message.receiptHandle);

  console.log(
    {
      messageId: message.messageId,
      processingJobId: message.body.processingJobId,
      userId: message.body.userId,
    },
    "SQS message processed and deleted",
  );
}

main().catch((error) => {
  console.error(error, "worker failed");
  process.exit(1);
});

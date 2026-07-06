import { Broker } from "./modules/broker/service";
import { ProcessingJobService } from "./modules/processing-jobs/service";
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

  try {
    await ProcessingJobService.updateStatus({
      processingJobId: message.body.processingJobId,
      status: "PROCESSING",
    });

    await processVideo(message.body);

    await ProcessingJobService.updateStatus({
      processingJobId: message.body.processingJobId,
      status: "COMPLETED",
    });
  } catch (error) {
    await ProcessingJobService.updateStatus({
      processingJobId: message.body.processingJobId,
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    throw error;
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

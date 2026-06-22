import { Broker } from "./modules/broker/service";
import { processVideo } from "./modules/video/processor";

async function main() {
  const message = await Broker.receiveVideoMessage();

  if (!message) {
    console.log("No message available. Worker finished without processing.");
    return;
  }

  console.log(
    {
      messageId: message.messageId,
      videoId: message.body.videoId,
    },
    "processing SQS message",
  );

  await processVideo(message.body);
  await Broker.deleteVideoMessage(message.receiptHandle);

  console.log(
    {
      messageId: message.messageId,
      videoId: message.body.videoId,
    },
    "SQS message processed and deleted",
  );
}

main().catch((error) => {
  console.error(error, "worker failed");
  process.exit(1);
});
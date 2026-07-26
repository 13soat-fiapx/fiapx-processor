import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { getQueueName } from "../../config";
import { sqsClient } from "../aws";

const cache = new Map<string, string>();

/** Drops the memoized queue URLs so each test resolves against its own SQS stub. */
export function resetQueueUrlCache() {
  cache.clear();
}

export async function resolveQueueUrl(eventType: string): Promise<string> {
  const cached = cache.get(eventType);
  if (cached) return cached;

  const queueName = getQueueName(eventType);
  const { QueueUrl } = await sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));

  if (!QueueUrl) throw new Error(`Queue not found: ${queueName}`);

  cache.set(eventType, QueueUrl);
  return QueueUrl;
}

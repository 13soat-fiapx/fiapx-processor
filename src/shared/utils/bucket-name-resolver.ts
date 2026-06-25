import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { stsClient } from "../aws";

let cachedBucketName: string | undefined;

export async function resolveBucketName(prefix: string): Promise<string> {
  if (cachedBucketName) return cachedBucketName;

  const { Account } = await stsClient.send(new GetCallerIdentityCommand({}));

  if (!Account) throw new Error("Could not determine AWS account ID.");

  cachedBucketName = `${prefix}-${Account}`;
  return cachedBucketName;
}

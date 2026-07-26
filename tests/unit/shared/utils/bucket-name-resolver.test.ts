import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { stsClient } from "../../../../src/shared/aws";
import {
  resetBucketNameCache,
  resolveBucketName,
} from "../../../../src/shared/utils/bucket-name-resolver";

const PREFIX = "fiapx-dev-artifacts";
const ACCOUNT = "000000000000";

let send: ReturnType<typeof spyOn<typeof stsClient, "send">>;

beforeEach(() => {
  // The cache is module-global and Bun runs the whole suite in one process, so without this
  // every test after the first would read the previous one's account id.
  resetBucketNameCache();

  spyOn(console, "log").mockImplementation(() => {});

  send = spyOn(stsClient, "send").mockImplementation(
    (async () => ({ Account: ACCOUNT })) as typeof stsClient.send,
  );
});

afterEach(() => {
  resetBucketNameCache();
  mock.restore();
});

describe("resolveBucketName", () => {
  test("appends the caller's account id to the prefix", async () => {
    expect(await resolveBucketName(PREFIX)).toBe(`${PREFIX}-${ACCOUNT}`);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCallerIdentityCommand);
  });

  test("calls STS only once across repeated lookups", async () => {
    await resolveBucketName(PREFIX);
    await resolveBucketName(PREFIX);

    expect(send).toHaveBeenCalledTimes(1);
  });

  test("throws when STS returns no account id", async () => {
    send.mockImplementation((async () => ({})) as typeof stsClient.send);

    await expect(resolveBucketName(PREFIX)).rejects.toThrow(
      "Could not determine AWS account ID.",
    );
  });

  test("resolves again after the cache is reset", async () => {
    await resolveBucketName(PREFIX);
    resetBucketNameCache();
    await resolveBucketName(PREFIX);

    expect(send).toHaveBeenCalledTimes(2);
  });

  // Documents current behaviour, not desired behaviour: the memo is keyed on nothing, so a
  // second prefix reads back the first one's bucket. Latent today — only one prefix is in use.
  test("ignores the prefix once the cache is warm", async () => {
    await resolveBucketName(PREFIX);

    expect(await resolveBucketName("another-prefix")).toBe(`${PREFIX}-${ACCOUNT}`);
  });
});

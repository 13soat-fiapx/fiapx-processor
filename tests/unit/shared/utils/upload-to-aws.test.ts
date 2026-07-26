import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { s3Client } from "../../../../src/shared/aws";
import {
  deleteFromAwsS3,
  downloadFromAwsS3,
  uploadToAwsS3,
} from "../../../../src/shared/utils/upload-to-aws";

const BUCKET = "fiapx-dev-artifacts-000000000000";
const KEY = "videos/job-123/original.mp4";

let send: ReturnType<typeof spyOn<typeof s3Client, "send">>;

function respondWith(response: unknown) {
  send.mockImplementation((async () => response) as typeof s3Client.send);
}

function sentCommand<T>(type: new (...args: never[]) => T): T | undefined {
  return send.mock.calls.map(([call]) => call).find((call): call is T => call instanceof type);
}

beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => {});

  send = spyOn(s3Client, "send").mockImplementation((async () => ({})) as typeof s3Client.send);
});

afterEach(() => {
  mock.restore();
});

describe("downloadFromAwsS3", () => {
  test("fetches the object and returns its bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    respondWith({ Body: { transformToByteArray: async () => bytes } });

    expect(await downloadFromAwsS3(BUCKET, KEY)).toEqual(bytes);
    expect(sentCommand(GetObjectCommand)?.input).toEqual({ Bucket: BUCKET, Key: KEY });
  });

  test("throws when the object has no body", async () => {
    respondWith({});

    await expect(downloadFromAwsS3(BUCKET, KEY)).rejects.toThrow("S3 object body is empty");
  });
});

describe("uploadToAwsS3", () => {
  const body = new Uint8Array([4, 5, 6]);

  test("puts the object with the supplied content type", async () => {
    await uploadToAwsS3(BUCKET, KEY, body, "image/jpeg");

    expect(sentCommand(PutObjectCommand)?.input).toEqual({
      Bucket: BUCKET,
      Key: KEY,
      Body: body,
      ContentType: "image/jpeg",
    });
  });

  test("falls back to a binary content type when none is given", async () => {
    await uploadToAwsS3(BUCKET, KEY, body);

    expect(sentCommand(PutObjectCommand)?.input.ContentType).toBe("application/octet-stream");
  });
});

describe("deleteFromAwsS3", () => {
  test("deletes the object", async () => {
    await deleteFromAwsS3(BUCKET, KEY);

    expect(sentCommand(DeleteObjectCommand)?.input).toEqual({ Bucket: BUCKET, Key: KEY });
  });
});

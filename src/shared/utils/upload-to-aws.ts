import {
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { s3Client } from "../aws";

async function bodyToArrayBuffer(body: GetObjectCommandOutput["Body"]) {
  if (!body) {
    throw new Error("S3 object body is empty");
  }

  return await body.transformToByteArray();
}

export async function downloadFromAwsS3(bucket: string, key: string) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  return bodyToArrayBuffer(response.Body);
}

export async function uploadToAwsS3(
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
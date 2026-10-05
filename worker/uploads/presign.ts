/**
 * STM-13: a presigned R2 PUT URL (S3 API, SigV4 in the query string).
 *
 * The signature covers Content-Type and Content-Length, so the browser can
 * only PUT a PDF of exactly the size it declared (and that size was checked
 * against the 20 MB cap before signing). X-Amz-Expires keeps it short-lived.
 * R2 ignores the region; "auto" is what Cloudflare documents.
 */
import { AwsV4Signer } from "aws4fetch";

export type R2Credentials = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export async function presignPut(
  creds: R2Credentials,
  key: string,
  { contentType, contentLength, ttlSeconds, now }: { contentType: string; contentLength: number; ttlSeconds: number; now: Date },
): Promise<string> {
  const url = new URL(`https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucket}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  const signer = new AwsV4Signer({
    method: "PUT",
    url: url.toString(),
    headers: { "Content-Type": contentType, "Content-Length": String(contentLength) },
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: "s3",
    region: "auto",
    signQuery: true,
    // Sign Content-Length too (aws4fetch skips it by default).
    allHeaders: true,
    datetime: now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
  });
  const signed = await signer.sign();
  return signed.url.toString();
}

import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { presignPut } from "./presign";

const creds = { accountId: "acct", bucket: "createmyq-uploads-dev", accessKeyId: "AKID", secretAccessKey: "SECRET" };
const now = new Date("2026-10-05T18:00:00.000Z");
const opts = { contentType: "application/pdf", contentLength: 20 * 1024 * 1024, ttlSeconds: 300, now };
const key = "uploads/7c1f/9a2b.pdf";

/** SigV4 query signing written out by hand from the AWS spec, to check aws4fetch's output independently. */
function expectedSignature(url: URL): string {
  const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const params = [...url.searchParams].filter(([k]) => k !== "X-Amz-Signature");
  params.sort(([a], [b]) => (a < b ? -1 : 1));
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonical = [
    "PUT",
    url.pathname,
    query,
    `content-length:${opts.contentLength}\ncontent-type:${opts.contentType}\nhost:${url.host}\n`,
    "content-length;content-type;host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = "20261005/auto/s3/aws4_request";
  const toSign = ["AWS4-HMAC-SHA256", "20261005T180000Z", scope, sha(canonical)].join("\n");
  let k: Buffer = hmac(`AWS4${creds.secretAccessKey}`, "20261005");
  for (const part of ["auto", "s3", "aws4_request"]) k = hmac(k, part);
  return createHmac("sha256", k).update(toSign).digest("hex");
}

describe("presignPut", () => {
  it("signs a PUT to the bucket's S3 endpoint, short-lived, binding type and length", async () => {
    const url = new URL(await presignPut(creds, key, opts));
    expect(url.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/createmyq-uploads-dev/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261005T180000Z");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKID/20261005/auto/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature(url));
  });

  it("gives a different signature for a different length (R2 rejects a mismatched body)", async () => {
    const a = new URL(await presignPut(creds, key, opts)).searchParams.get("X-Amz-Signature");
    const b = new URL(await presignPut(creds, key, { ...opts, contentLength: 1 })).searchParams.get("X-Amz-Signature");
    expect(a).not.toBe(b);
  });
});

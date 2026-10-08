/**
 * STM-13: the rules of the upload path, as pure functions. Routes parse with
 * the schemas here, presign.ts signs, and the R2 binding answers the HEAD.
 *
 * The flow:
 *   1. POST /api/uploads { filename, size, contentType } → checkUploadRequest,
 *      a fresh source id, the object key and a presigned PUT URL. No row yet:
 *      a URL that is never used leaves nothing behind in Postgres.
 *   2. The browser PUTs the file straight to R2. The bytes never touch /api.
 *   3. POST /api/uploads/complete { sourceId, filename } → HEAD the object,
 *      checkUploadedObject, then the `sources` row (status `uploaded`).
 *
 * The key holds the uploader's users.id, so a user can only ever complete (or
 * see) objects under their own prefix: the id comes from the verified session.
 */
import { z } from "zod";

/** PDF ≤ 20 MB (CLAUDE.md "Limits"). The 50-page cap needs parsing: STM-14. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const PDF_CONTENT_TYPE = "application/pdf";
/** How long a presigned PUT URL stays valid. Minutes, not hours. */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;

export const TOO_BIG = "This file is over 20 MB. Try a smaller PDF.";
export const NOT_PDF = "Only PDF files can be uploaded for now.";

const filename = z.string().trim().min(1).max(255);
/** STM-24: the browser's IANA time zone, for "today" in the daily cap. Invalid or missing → UTC. */
const timeZone = z.string().max(64).optional();

/** Shape only; size and type get their own friendly messages from checkUploadRequest. */
export const createUploadBody = z.strictObject({
  filename,
  size: z.number().int(),
  contentType: z.string().max(255),
  timeZone,
});
export type CreateUploadBody = z.infer<typeof createUploadBody>;

export const completeUploadBody = z.strictObject({ sourceId: z.uuid(), filename, timeZone });

export type Check = { ok: true } | { ok: false; error: string; code: "too_large" | "not_pdf" | "empty" };

/** Size and type, before anything is signed. */
export function checkUploadRequest(req: Pick<CreateUploadBody, "filename" | "size" | "contentType">): Check {
  const isPdf = req.contentType.toLowerCase() === PDF_CONTENT_TYPE && /\.pdf$/i.test(req.filename.trim());
  if (!isPdf) return { ok: false, error: NOT_PDF, code: "not_pdf" };
  if (req.size <= 0) return { ok: false, error: "This file is empty.", code: "empty" };
  if (req.size > MAX_UPLOAD_BYTES) return { ok: false, error: TOO_BIG, code: "too_large" };
  return { ok: true };
}

/** What R2 says it stored, re-checked: the signed headers should already guarantee it. */
export function checkUploadedObject(obj: { size: number; contentType: string | undefined }): Check {
  if ((obj.contentType ?? "").toLowerCase() !== PDF_CONTENT_TYPE) {
    return { ok: false, error: NOT_PDF, code: "not_pdf" };
  }
  if (obj.size <= 0) return { ok: false, error: "This file is empty.", code: "empty" };
  if (obj.size > MAX_UPLOAD_BYTES) return { ok: false, error: TOO_BIG, code: "too_large" };
  return { ok: true };
}

/** The object key for a user's upload. The users.id prefix is what scopes it to them. */
export function uploadKey(userId: string, sourceId: string): string {
  return `uploads/${userId}/${sourceId}.pdf`;
}

/** The title shown in the user's library: the filename without ".pdf". */
export function titleFromFilename(name: string): string {
  const title = name.trim().replace(/\.pdf$/i, "").trim();
  return title.slice(0, 200) || "Untitled PDF";
}

export function uploadExpiresAt(now: Date, ttlSeconds = UPLOAD_URL_TTL_SECONDS): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}

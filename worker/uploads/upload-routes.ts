/**
 * STM-13: the upload path. The file goes browser → R2 on a presigned URL; these
 * routes only sign, verify and record. See upload-rules.ts for the flow.
 *
 *   POST /api/uploads           { filename, size, contentType } → { sourceId, uploadUrl, expiresAt }
 *   POST /api/uploads/complete  { sourceId, filename } → HEAD the object, create the source row,
 *                               and queue it for generation (STM-15)
 *   GET  /api/uploads/:id       the caller's own upload, with its status
 *
 * A duplicate upload (STM-16: the same text was uploaded before) reports the
 * status of the bank it shares, and `bankSourceId` names that bank.
 *
 * Keys are built from the session's users.id, never from the request, so
 * another user's sourceId only ever resolves to a key under the caller's own
 * prefix (404).
 */
import { Hono, type Context } from "hono";
import { and, eq, exists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { AppEnv } from "../auth/session";
import type { Db } from "../db/client";
import { sourceUploads, sources } from "../db/schema";
import { apiError, readJson } from "../http";
import type { GenerationMessage } from "../workflows/queue";
import type { SourceStatus } from "../workflows/rules";
import { presignPut, type R2Credentials } from "./presign";
import {
  PDF_CONTENT_TYPE,
  UPLOAD_URL_TTL_SECONDS,
  checkUploadRequest,
  checkUploadedObject,
  completeUploadBody,
  createUploadBody,
  titleFromFilename,
  uploadExpiresAt,
  uploadKey,
} from "./upload-rules";

export const uploadRoutes = new Hono<AppEnv>();

const notFound = (c: Context) =>
  apiError(c, 404, "We could not find that upload. Please try uploading the file again.", {
    code: "upload_not_found",
  });

/** The R2 API token is two secrets; missing either fails closed. */
function r2Credentials(env: Env): R2Credentials | null {
  const { R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = env as {
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
  };
  if (!accessKeyId || !secretAccessKey) return null;
  return { accountId: env.R2_ACCOUNT_ID, bucket: env.UPLOADS_BUCKET_NAME, accessKeyId, secretAccessKey };
}

uploadRoutes.post("/uploads", async (c) => {
  const input = createUploadBody.safeParse(await readJson(c));
  if (!input.success) return apiError(c, 400, "Pick a PDF to upload.");
  const check = checkUploadRequest(input.data);
  if (!check.ok) return apiError(c, check.code === "too_large" ? 413 : 400, check.error, { code: check.code });

  const creds = r2Credentials(c.env);
  if (!creds) {
    console.error("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set; uploads are off");
    return apiError(c, 500, "Uploads are not available right now.");
  }

  const now = new Date();
  const sourceId = crypto.randomUUID();
  const uploadUrl = await presignPut(creds, uploadKey(c.var.user.id, sourceId), {
    contentType: PDF_CONTENT_TYPE,
    contentLength: input.data.size,
    ttlSeconds: UPLOAD_URL_TTL_SECONDS,
    now,
  });
  return c.json({
    sourceId,
    uploadUrl,
    // The PUT must send exactly this (Content-Length is set by the browser from the file).
    headers: { "Content-Type": PDF_CONTENT_TYPE },
    expiresAt: uploadExpiresAt(now).toISOString(),
  });
});

uploadRoutes.post("/uploads/complete", async (c) => {
  const input = completeUploadBody.safeParse(await readJson(c));
  if (!input.success) return apiError(c, 400, "That upload could not be confirmed.");
  const { sourceId, filename } = input.data;
  const userId = c.var.user.id;
  const key = uploadKey(userId, sourceId);

  const object = await c.env.UPLOADS.head(key);
  if (!object) return notFound(c);
  const check = checkUploadedObject({ size: object.size, contentType: object.httpMetadata?.contentType });
  if (!check.ok) {
    await c.env.UPLOADS.delete(key);
    return apiError(c, check.code === "too_large" ? 413 : 400, check.error, { code: check.code });
  }

  // Idempotent: a retried complete finds the row already there.
  await c.var.db.transaction(async (tx) => {
    await tx
      .insert(sources)
      .values({
        id: sourceId,
        ownerId: userId,
        visibility: "private",
        kind: "pdf",
        r2Key: key,
        title: titleFromFilename(filename),
        status: "uploaded",
      })
      .onConflictDoNothing();
    await tx.insert(sourceUploads).values({ userId, sourceId }).onConflictDoNothing();
  });

  const source = await findOwnSource(c.var.db, userId, sourceId);
  if (!source) return notFound(c);
  // Queue it while it is still waiting. A retried complete may send twice; the
  // consumer starts one run per source either way (worker/workflows/queue.ts).
  if (source.status === "uploaded") {
    await c.env.GENERATION_QUEUE.send({ sourceId } satisfies GenerationMessage);
  }
  return c.json({ source });
});

uploadRoutes.get("/uploads/:id", async (c) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success) return notFound(c);
  const source = await findOwnSource(c.var.db, c.var.user.id, id.data);
  return source ? c.json({ source }) : notFound(c);
});

/**
 * A source the user uploaded (source_uploads), or null. Never anyone else's.
 * For a duplicate, `status` is the bank's: that is what the user will get.
 */
async function findOwnSource(db: Db, userId: string, sourceId: string) {
  const bank = alias(sources, "bank");
  const [row] = await db
    .select({
      id: sources.id,
      title: sources.title,
      status: sql<SourceStatus>`coalesce(${bank.status}, ${sources.status})`,
      bankSourceId: sql<string>`coalesce(${sources.duplicateOfId}, ${sources.id})`,
      createdAt: sources.createdAt,
    })
    .from(sources)
    .leftJoin(bank, eq(bank.id, sources.duplicateOfId))
    .where(
      and(
        eq(sources.id, sourceId),
        exists(
          db
            .select()
            .from(sourceUploads)
            .where(and(eq(sourceUploads.sourceId, sources.id), eq(sourceUploads.userId, userId))),
        ),
      ),
    );
  return row ?? null;
}

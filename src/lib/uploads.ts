/**
 * The upload API as the browser sees it (STM-13, worker/uploads/upload-routes.ts).
 * The file goes straight to R2 on a presigned URL; /api only signs and records.
 */
import { ApiError, api } from "./api";
import type { SourceStatus } from "./sources";

export type UploadedSource = { id: string; title: string | null; status: SourceStatus; bankSourceId: string; createdAt: string };

type Ticket = { sourceId: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string };

/**
 * STM-24: the daily generation cap counts the user's own calendar day, so the
 * server is told the browser's time zone. Cap and spend-ceiling refusals come
 * back as ApiErrors whose message (with the reset time) is shown as is.
 */
function timeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * The file never reached storage (network, CORS or R2 refusing the signed PUT).
 * Said here, and `complete` is not called: it could only answer "could not find
 * that upload", which would blame the wrong step.
 */
export const PUT_FAILED = "Your file did not reach our storage, so nothing was uploaded. Check your connection and try again.";

/** Ask for a URL (the server checks size and type), PUT the file to R2, then confirm. */
export async function uploadPdf(file: File): Promise<UploadedSource> {
  const ticket = await api<Ticket>("/uploads", {
    body: { filename: file.name, size: file.size, contentType: file.type || "application/octet-stream", timeZone: timeZone() },
  });

  let res: Response;
  try {
    // Not api(): this goes to R2, with no session token.
    res = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body: file });
  } catch {
    throw new ApiError(0, PUT_FAILED, "upload_put_failed");
  }
  if (!res.ok) throw new ApiError(res.status, PUT_FAILED, "upload_put_failed");

  const done = await api<{ source: UploadedSource }>("/uploads/complete", {
    body: { sourceId: ticket.sourceId, filename: file.name, timeZone: timeZone() },
  });
  return done.source;
}

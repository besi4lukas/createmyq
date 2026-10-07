/**
 * The upload API as the browser sees it (STM-13, worker/uploads/upload-routes.ts).
 * The file goes straight to R2 on a presigned URL; /api only signs and records.
 */
import { useCallback, useState } from "react";
import { ApiError, api, friendlyError } from "./api";

export type SourceStatus = "uploaded" | "processing" | "ready" | "refused" | "failed" | "duplicate";
export type UploadedSource = { id: string; title: string | null; status: SourceStatus; bankSourceId: string; createdAt: string };

type Ticket = { sourceId: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string };

const PUT_FAILED = "The upload did not go through. Check your connection and try again.";

/** Ask for a URL (the server checks size and type), PUT the file to R2, then confirm. */
export async function uploadPdf(file: File): Promise<UploadedSource> {
  const ticket = await api<Ticket>("/uploads", {
    body: { filename: file.name, size: file.size, contentType: file.type || "application/octet-stream" },
  });

  let res: Response;
  try {
    // Not api(): this goes to R2, with no session token.
    res = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body: file });
  } catch {
    throw new ApiError(0, PUT_FAILED);
  }
  if (!res.ok) throw new ApiError(res.status, PUT_FAILED);

  const done = await api<{ source: UploadedSource }>("/uploads/complete", {
    body: { sourceId: ticket.sourceId, filename: file.name },
  });
  return done.source;
}

export type UploadState =
  | { status: "idle" }
  | { status: "uploading"; filename: string }
  | { status: "done"; source: UploadedSource }
  | { status: "error"; message: string };

export function useUpload() {
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const upload = useCallback(async (file: File) => {
    setState({ status: "uploading", filename: file.name });
    try {
      setState({ status: "done", source: await uploadPdf(file) });
    } catch (err) {
      setState({ status: "error", message: friendlyError(err) });
    }
  }, []);
  return { state, upload };
}

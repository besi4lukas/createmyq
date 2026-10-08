/**
 * Your own material (design v2, "Bring your own material"): a PDF, an article
 * link or a YouTube link becomes a source, and the source's status is polled
 * until the background run finishes. PDFs go through uploads.ts (browser → R2);
 * links go to POST /api/sources/link. Status: GET /api/sources/:id.
 *
 * The rules here are pure (checkLinkInput, checkPdfFile, sourceView) and unit
 * tested; the server checks everything again.
 */
import { useEffect, useState } from "react";
import { api, friendlyError } from "./api";

export type SourceKind = "pdf" | "article" | "youtube";
export type SourceStatus = "uploaded" | "processing" | "ready" | "refused" | "failed" | "duplicate";

export type Source = {
  id: string;
  kind: SourceKind;
  title: string | null;
  url: string | null;
  status: SourceStatus;
  /** The user-facing message the run stored: the off-topic refusal, scanned PDF, too thin… */
  error: string | null;
  bankSourceId: string;
  questionCount: number;
  createdAt: string;
};

export const KINDS: { value: SourceKind; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "article", label: "Article" },
  { value: "youtube", label: "YouTube" },
];

/* The 20 MB rule and its copy match worker/uploads/upload-rules.ts. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const NOT_PDF = "Only PDF files can be uploaded for now.";
export const TOO_BIG = "This file is over 20 MB. Try a smaller PDF.";
export const EMPTY_FILE = "This file is empty.";

export const NO_LINK = "Paste a link first.";
export const BAD_LINK = "That doesn't look like a web link. Paste a link that starts with https://.";
export const NOT_YOUTUBE = "That isn't a YouTube link. For other web pages, choose Article.";
export const IS_YOUTUBE = "That's a YouTube link. Choose YouTube above.";

const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com)$|^youtu\.be$/i;

/** The obvious mistakes, said before anything is sent. Null = send it. */
export function checkLinkInput(kind: "article" | "youtube", text: string): string | null {
  const input = text.trim();
  if (!input) return NO_LINK;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return BAD_LINK;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return BAD_LINK;
  const youtube = YOUTUBE_HOST.test(url.hostname);
  if (kind === "youtube" && !youtube) return NOT_YOUTUBE;
  if (kind === "article" && youtube) return IS_YOUTUBE;
  return null;
}

/** Type and size before asking for an upload URL. Pages are checked by the run (≤ 50). */
export function checkPdfFile(file: { name: string; size: number; type: string }): string | null {
  const isPdf = file.type === "application/pdf" || (!file.type && /\.pdf$/i.test(file.name));
  if (!isPdf || !/\.pdf$/i.test(file.name)) return NOT_PDF;
  if (file.size <= 0) return EMPTY_FILE;
  if (file.size > MAX_PDF_BYTES) return TOO_BIG;
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function timeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** `requestId` is made once per press of "Make my quiz", so a retry is the same source. */
export async function submitLink(url: string, requestId: string): Promise<{ id: string }> {
  const { source } = await api<{ source: { id: string } }>("/sources/link", {
    body: { url: url.trim(), requestId, timeZone: timeZone() },
  });
  return source;
}

export async function getSource(id: string): Promise<Source> {
  return (await api<{ source: Source }>(`/sources/${id}`)).source;
}

/** Still running: keep polling. */
export function isWorking(status: SourceStatus): boolean {
  return status === "uploaded" || status === "processing" || status === "duplicate";
}

export type SourceView =
  | { phase: "working"; kicker: "Working on it"; title: "Making your quiz" }
  | { phase: "ready"; kicker: "Done" | "Already in the pool"; title: "Your quiz is ready." | "We’ve seen this one."; cached: boolean; count: number }
  | { phase: "refused"; title: "This one’s not really our thing."; message: string }
  | { phase: "failed"; kicker: "Didn’t work"; title: "We couldn’t make a quiz from this."; message: string };

export const REFUSED_FALLBACK = "This looks like a different subject. CreateMyQ only covers software engineering right now.";
export const FAILED_FALLBACK = "Something went wrong while making your quiz. Please try again later.";

/** What the status screen shows for a source. The stored `error` is shown as is. */
export function sourceView(s: Pick<Source, "id" | "status" | "error" | "bankSourceId" | "questionCount">): SourceView {
  switch (s.status) {
    case "uploaded":
    case "processing":
    case "duplicate":
      return { phase: "working", kicker: "Working on it", title: "Making your quiz" };
    case "ready": {
      const cached = s.bankSourceId !== s.id;
      return cached
        ? { phase: "ready", kicker: "Already in the pool", title: "We’ve seen this one.", cached, count: s.questionCount }
        : { phase: "ready", kicker: "Done", title: "Your quiz is ready.", cached, count: s.questionCount };
    }
    case "refused":
      return { phase: "refused", title: "This one’s not really our thing.", message: s.error ?? REFUSED_FALLBACK };
    case "failed":
      return { phase: "failed", kicker: "Didn’t work", title: "We couldn’t make a quiz from this.", message: s.error ?? FAILED_FALLBACK };
    default:
      return s.status satisfies never;
  }
}

/** "1:05" since `from`. */
export function elapsed(from: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - Date.parse(from)) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export const POLL_MS = 3000;

export type SourceState =
  | { status: "loading" }
  | { status: "ok"; source: Source }
  | { status: "error"; message: string; last: Source | null };

/** Load the source, then poll it while its run is working. Stops on unmount and when finished. */
export function useSourceStatus(id: string): SourceState {
  const [state, setState] = useState<SourceState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: Source | null = null;
    const tick = async () => {
      try {
        const source = await getSource(id);
        if (cancelled) return;
        last = source;
        setState({ status: "ok", source });
        if (isWorking(source.status)) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setState({ status: "error", message: friendlyError(err), last });
        // A blip while polling: try again a little later.
        if (last && isWorking(last.status)) timer = setTimeout(() => void tick(), POLL_MS * 2);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);
  return state;
}

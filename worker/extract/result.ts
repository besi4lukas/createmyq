/**
 * STM-14: what extraction returns. Every extractor (PDF, article, YouTube)
 * ends in one of these, so the STM-15 Workflow's Extract step can store the
 * text or write `sources.status = 'failed'` + `sources.error = message`.
 *
 * `retryable` says whether running the step again could help (a network blip,
 * a timeout, YouTube rate limiting). Everything else is a property of the
 * source itself and fails the job straight away.
 */
import type { sourceKind } from "../db/schema";

export type SourceKind = (typeof sourceKind.enumValues)[number];

/** A char range [start, end) into `text`, e.g. one PDF page. */
export type Span = { label: string; start: number; end: number };

export type Extracted = {
  ok: true;
  kind: SourceKind;
  /** Normalised text (see normalise.ts). What chunking and generation read. */
  text: string;
  /** sha256 over the canonical form of `text` (see fingerprint.ts). Goes in `sources.content_hash`. */
  fingerprint: string;
  title: string | null;
  /** Where the text came from after redirects (article), or the watch URL (YouTube). */
  url: string | null;
  /** PDF pages ("p. 3") or caption paragraphs ("12:30"), as char ranges into `text`. */
  spans: Span[];
  meta: Record<string, string | number | boolean | null>;
};

export type ExtractErrorCode =
  | "scanned_pdf"
  | "unreadable_pdf"
  | "too_large"
  | "too_many_pages"
  | "bad_url"
  | "blocked_url"
  | "fetch_failed"
  | "not_html"
  | "no_article_text"
  | "youtube_unavailable"
  | "youtube_no_captions"
  | "youtube_blocked";

export type ExtractFailure = {
  ok: false;
  code: ExtractErrorCode;
  /** Shown to the user as is. */
  message: string;
  retryable: boolean;
  /** For logs only, never shown to the user. */
  detail?: string;
};

export type ExtractResult = Extracted | ExtractFailure;

/** CLAUDE.md "User-facing messages": exact string. */
export const SCANNED_PDF = "I could not read this file. Scanned PDFs are not supported yet.";

export const MAX_PDF_PAGES = 50;

export function fail(
  code: ExtractErrorCode,
  message: string,
  opts: { retryable?: boolean; detail?: string } = {},
): ExtractFailure {
  return { ok: false, code, message, retryable: opts.retryable ?? false, ...(opts.detail ? { detail: opts.detail } : {}) };
}

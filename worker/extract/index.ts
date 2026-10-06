/**
 * STM-14: the Extract + Fingerprint steps of the generation pipeline, as plain
 * functions. The STM-15 Workflow calls extractSource() with what the `sources`
 * row holds: the PDF's bytes (read from R2 at `r2_key`) or the pasted `url`.
 *
 * On success: normalised text, its fingerprint (for `content_hash`, STM-16),
 * a title and char-range spans. On failure: a typed reason with the exact
 * message to store in `sources.error` and show the user.
 *
 * Runs in workerd and in Node (no Workers-only globals), so the operator
 * script scripts/extract.ts uses the same code.
 */
import { assertNever } from "../lib/assert";
import { extractArticle } from "./article";
import { extractPdf } from "./pdf";
import { fail, type ExtractResult } from "./result";
import { BAD_URL, parseSourceUrl } from "./source-url";
import { extractYouTube } from "./youtube";

export type ExtractInput = { kind: "pdf"; bytes: Uint8Array } | { kind: "article" | "youtube"; url: string };

export async function extractSource(input: ExtractInput, fetchImpl?: typeof fetch): Promise<ExtractResult> {
  switch (input.kind) {
    case "pdf":
      return extractPdf(input.bytes);
    case "article":
    case "youtube": {
      const parsed = parseSourceUrl(input.url);
      if ("ok" in parsed) return parsed;
      // The row's kind and its URL must agree; a mismatch is a bug upstream.
      if (parsed.kind !== input.kind) return fail("bad_url", BAD_URL, { detail: `kind ${input.kind} vs ${parsed.kind}` });
      return parsed.kind === "youtube" ? extractYouTube(parsed.videoId, fetchImpl) : extractArticle(parsed.url, fetchImpl);
    }
    default:
      return assertNever(input);
  }
}

export { parseSourceUrl } from "./source-url";
export type { Extracted, ExtractFailure, ExtractResult, ExtractErrorCode, Span } from "./result";
export { SCANNED_PDF, MAX_PDF_PAGES } from "./result";

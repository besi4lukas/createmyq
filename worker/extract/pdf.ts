/**
 * STM-14: PDF bytes → text, through unpdf (a serverless build of PDF.js that
 * runs on Workers). The caller reads the object from R2 (`UPLOADS`, key
 * `uploads/<users.id>/<sourceId>.pdf`) and hands over the bytes.
 *
 * Order matters for cost: size first (no parsing), then the page count (only
 * the cross-reference table), then the text of every page.
 *
 *   > 20 MB                        → too_large (the upload path's own message)
 *   > 50 pages                     → too_many_pages
 *   encrypted / not a PDF          → unreadable_pdf
 *   (almost) no text after cleanup → scanned_pdf, exactly SCANNED_PDF
 *
 * Each page is normalised on its own and pages are joined with a blank line,
 * so every page has a char range in `spans` ("p. 3"). Lines repeated at the
 * top or bottom of most pages (running headers/footers) and bare page numbers
 * are dropped first.
 */
import { extractText, getDocumentProxy } from "unpdf";
import { MAX_UPLOAD_BYTES, TOO_BIG } from "../uploads/upload-rules";
import { fingerprint } from "./fingerprint";
import { countLetters, normaliseText } from "./normalise";
import { fail, MAX_PDF_PAGES, SCANNED_PDF, type ExtractResult, type Span } from "./result";

/** Below either of these, the PDF is treated as scanned (images of text, no text layer). */
export const MIN_PDF_LETTERS = 200;
export const MIN_LETTERS_PER_PAGE = 25;

export const UNREADABLE_PDF = "I could not read this file. It may be damaged or not a PDF.";
export const ENCRYPTED_PDF = "This PDF is password-protected. Upload a copy without a password.";

export function tooManyPages(pages: number): string {
  return `This PDF has ${pages} pages. The limit is ${MAX_PDF_PAGES}.`;
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return fail("too_large", TOO_BIG);
  if (bytes.byteLength === 0) return fail("unreadable_pdf", UNREADABLE_PDF, { detail: "empty" });

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // PDF.js may detach the buffer it is given; keep the caller's intact.
    pdf = await getDocumentProxy(bytes.slice());
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "PasswordException") return fail("unreadable_pdf", ENCRYPTED_PDF);
    return fail("unreadable_pdf", UNREADABLE_PDF, { detail: `${name}: ${String(err)}`.slice(0, 300) });
  }

  try {
    if (pdf.numPages > MAX_PDF_PAGES) return fail("too_many_pages", tooManyPages(pdf.numPages));
    const { text: rawPages } = await extractText(pdf, { mergePages: false });
    const { text, spans } = joinPages(stripRunningLines(rawPages));
    if (looksScanned(text, pdf.numPages)) return fail("scanned_pdf", SCANNED_PDF);
    return {
      ok: true,
      kind: "pdf",
      text,
      fingerprint: await fingerprint(text),
      title: await pdfTitle(pdf),
      url: null,
      spans,
      meta: { pages: pdf.numPages, bytes: bytes.byteLength },
    };
  } catch (err) {
    return fail("unreadable_pdf", UNREADABLE_PDF, { detail: String(err).slice(0, 300) });
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

async function pdfTitle(pdf: Awaited<ReturnType<typeof getDocumentProxy>>): Promise<string | null> {
  try {
    const { info } = await pdf.getMetadata();
    const title = (info as { Title?: unknown } | undefined)?.Title;
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** Pure: no text layer, or only a sprinkle of it (a page number, a stamp). */
export function looksScanned(text: string, pages: number): boolean {
  const letters = countLetters(text);
  return letters < MIN_PDF_LETTERS || letters / Math.max(pages, 1) < MIN_LETTERS_PER_PAGE;
}

/** Pure: normalise each page, join with a blank line, record each non-empty page's range. */
export function joinPages(pages: string[]): { text: string; spans: Span[] } {
  const spans: Span[] = [];
  let text = "";
  pages.forEach((raw, i) => {
    const page = normaliseText(raw);
    if (!page) return;
    if (text) text += "\n\n";
    spans.push({ label: `p. ${i + 1}`, start: text.length, end: text.length + page.length });
    text += page;
  });
  return { text, spans };
}

const EDGE_LINES = 2;
/** Shorter pages (slides, title pages, synthetic repeats) are left alone: too little to tell header from body. */
const MIN_LINES_FOR_EDGES = 10;
/** Running headers are short; a long line at the top of a page is body text. */
const MAX_RUNNING_LINE = 80;
const PAGE_NUMBER = /^(page\s*)?[-\u2013\u2014(]?\s*\d{1,4}\s*[-\u2013\u2014)]?(\s*(of|\/)\s*\d{1,4})?$/i;

/**
 * Pure: drop running headers/footers and bare page numbers (edge lines only).
 * A running line is a short line among the first or last EDGE_LINES lines of a
 * page whose shape (digits masked, so "Chapter 3 · 41" matches "Chapter 3 ·
 * 42") appears at the edge of at least 60% of pages. Needs 4+ pages to judge.
 * Pages under MIN_LINES_FOR_EDGES lines are left alone.
 */
export function stripRunningLines(pages: string[]): string[] {
  const split = pages.map((p) => p.split("\n"));
  const shape = (line: string) => line.trim().toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
  const edges = (lines: string[]) => {
    const idx = new Set<number>();
    if (lines.length < MIN_LINES_FOR_EDGES) return [];
    for (let i = 0; i < Math.min(EDGE_LINES, lines.length); i++) idx.add(i);
    for (let i = Math.max(0, lines.length - EDGE_LINES); i < lines.length; i++) idx.add(i);
    return [...idx];
  };

  const running = new Set<string>();
  if (pages.length >= 4) {
    const seen = new Map<string, number>();
    for (const lines of split) {
      const shapes = new Set(
        edges(lines)
          .map((i) => shape(lines[i] ?? ""))
          .filter((s) => s.length > 0 && s.length <= MAX_RUNNING_LINE),
      );
      for (const s of shapes) seen.set(s, (seen.get(s) ?? 0) + 1);
    }
    for (const [s, n] of seen) if (n >= pages.length * 0.6) running.add(s);
  }

  return split.map((lines) => {
    const edge = new Set(edges(lines));
    return lines
      .filter((line, i) => {
        if (!edge.has(i)) return true;
        return !PAGE_NUMBER.test(line.trim()) && !running.has(shape(line));
      })
      .join("\n");
  });
}

/**
 * STM-17: split a source's extracted text into chunks for question generation,
 * each carrying the heading path and character range a question cites. Pure
 * and deterministic: the same extraction always gives the same chunks.
 *
 * A chunk is a range, not text. The Workflow returns chunks from a step
 * (limited to 1 MiB), and the text is already the Extract step's result, so
 * later steps take `text.slice(chunk.start, chunk.end)`.
 *
 * How:
 *   1. Sections: the text between one heading (headings.ts) and the next. The
 *      heading line opens its section. Text before the first heading gets the
 *      source's title as its path, as does a source with no headings at all
 *      (YouTube, a plain PDF).
 *   2. A section longer than CHUNK_MAX_CHARS is cut into near-equal pieces of
 *      about CHUNK_TARGET_CHARS, at the best break near each cut: paragraph,
 *      then sentence, then line, then space. Never mid-word (unless there is
 *      no space at all in CHUNK_MAX_CHARS).
 *   3. A piece shorter than CHUNK_MIN_CHARS joins the next one (or, failing
 *      that, the previous one) while the result stays within CHUNK_MAX_CHARS.
 *      The joined chunk keeps the headings both parts share ("4 Refinements"
 *      for 4.2 + 4.3). Parts that share no heading stay apart (a citation
 *      must be true of the whole chunk), except the untitled opening, which
 *      joins the first section. So a short top-level section can stay short.
 *
 * Ranges are trimmed, so the text between two chunks is whitespace only, and
 * every non-whitespace character is in exactly one chunk.
 */
import type { SourceKind, Span } from "../extract/result";
import { assertNever } from "../lib/assert";
import { findHeadings } from "./headings";

/** ~1,000 tokens: room for two to four questions with context around them. */
export const CHUNK_TARGET_CHARS = 4000;
export const CHUNK_MAX_CHARS = 6000;
/** Below this a section is too thin to ask much about on its own. */
export const CHUNK_MIN_CHARS = 1200;

export type Chunk = {
  /** 0-based position in the source (`source_chunks.ordinal`). */
  ordinal: number;
  /** [start, end) into the normalised text (`source_chunks.char_start/char_end`). */
  start: number;
  end: number;
  /** Outermost heading first (`source_chunks.heading_path`). Empty when there is nothing to cite. */
  headingPath: string[];
  /** Where in the original: "p. 4", "pp. 4–5", "3:05–7:40". Null for articles. */
  location: string | null;
};

export type ChunkInput = { kind: SourceKind; text: string; title: string | null; spans: Span[] };

type Piece = { start: number; end: number; path: string[] };

export function chunkSource(input: ChunkInput): Chunk[] {
  const { kind, text, spans } = input;
  const fallback = usableTitle(input.title);

  const sections: Piece[] = [];
  let open: { level: number; title: string }[] = [];
  let cursor = 0;
  let path = fallback;
  for (const h of findHeadings(kind, text)) {
    sections.push({ start: cursor, end: h.start, path });
    open = [...open.filter((o) => o.level < h.level), { level: h.level, title: clip(h.title) }];
    path = open.map((o) => o.title);
    cursor = h.start;
  }
  sections.push({ start: cursor, end: text.length, path });

  const pieces = sections
    .map((s) => trim(text, s))
    .filter((s) => s.end > s.start)
    .flatMap((s) => split(text, s));
  return joinSmall(pieces, fallback).map((p, ordinal) => ({
    ordinal,
    start: p.start,
    end: p.end,
    headingPath: p.path,
    location: locate(kind, spans, p.start, p.end),
  }));
}

/** A PDF's metadata title is often the authoring tool's file name; leave those out. */
export function usableTitle(title: string | null): string[] {
  const t = title?.trim();
  if (!t) return [];
  if (/^microsoft (word|powerpoint|excel) - |\.(docx?|pptx?|tex|dvi|pdf)$|^untitled$/i.test(t)) return [];
  return [clip(t)];
}

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

function trim(text: string, p: Piece): Piece {
  let { start, end } = p;
  while (start < end && /\s/.test(text[start] as string)) start++;
  while (end > start && /\s/.test(text[end - 1] as string)) end--;
  return { ...p, start, end };
}

function split(text: string, section: Piece): Piece[] {
  const out: Piece[] = [];
  let start = section.start;
  while (section.end - start > CHUNK_MAX_CHARS) {
    const remaining = section.end - start;
    const aim = start + Math.round(remaining / Math.ceil(remaining / CHUNK_TARGET_CHARS));
    const cut = bestBreak(text, start + CHUNK_MIN_CHARS, aim, start + CHUNK_MAX_CHARS);
    out.push(trim(text, { start, end: cut, path: section.path }));
    start = trim(text, { start: cut, end: section.end, path: section.path }).start;
  }
  out.push({ start, end: section.end, path: section.path });
  return out;
}

/**
 * Where a piece ends, in [lo, hi], closest to `aim`, by preference: a blank
 * line, the end of a sentence, a line break, a space. A cut is the position
 * right after the piece's last character.
 */
const BREAKS: { re: RegExp; after: boolean }[] = [
  { re: /\n\n/g, after: false },
  { re: /[.!?]["')\]]?(?=\s+[\p{Lu}\d"'([]|\s*$)/gu, after: true },
  { re: /\n/g, after: false },
  { re: / /g, after: false },
];

export function bestBreak(text: string, lo: number, aim: number, hi: number): number {
  for (const { re, after } of BREAKS) {
    re.lastIndex = lo;
    let best = -1;
    for (let m = re.exec(text); m && m.index <= hi; m = re.exec(text)) {
      const at = after ? m.index + m[0].length : m.index;
      if (at < lo || at > hi) continue;
      if (best === -1 || Math.abs(at - aim) < Math.abs(best - aim)) best = at;
      else if (at > aim) break; // only getting further away
    }
    if (best !== -1) return best;
  }
  // No whitespace at all: cut anyway, but not inside a surrogate pair.
  return /[\uDC00-\uDFFF]/.test(text[hi] ?? "") ? hi - 1 : hi;
}

function joinSmall(pieces: Piece[], fallback: string[]): Piece[] {
  const size = (p: Piece) => p.end - p.start;
  const fits = (a: Piece, b: Piece) => b.end - a.start <= CHUNK_MAX_CHARS;
  const untitled = (p: Piece) => p.path.length === 0 || samePath(p.path, fallback);
  /**
   * The path of a + b, or null when they must stay apart: two sections share
   * no heading ("5.4 …" and "6 Experience"), so no path would be true of both.
   * The untitled opening (a PDF's title and authors) may join the first section.
   */
  const joined = (a: Piece, b: Piece): Piece | null => {
    const shared: string[] = [];
    for (let i = 0; i < Math.min(a.path.length, b.path.length) && a.path[i] === b.path[i]; i++) shared.push(a.path[i] as string);
    if (shared.length > 0) return { start: a.start, end: b.end, path: shared };
    if (untitled(a)) return { start: a.start, end: b.end, path: b.path };
    if (untitled(b)) return { start: a.start, end: b.end, path: a.path };
    return null;
  };
  const pass = (input: Piece[], small: (last: Piece, p: Piece) => boolean): Piece[] => {
    const out: Piece[] = [];
    for (const p of input) {
      const last = out.at(-1);
      const j = last && small(last, p) && fits(last, p) ? joined(last, p) : null;
      if (j) out[out.length - 1] = j;
      else out.push(p);
    }
    return out;
  };
  // Forward: a small piece takes in the next one(s). Then backward: whatever
  // is still small (a section's last piece, say) joins the previous one.
  const forward = pass(pieces, (last) => size(last) < CHUNK_MIN_CHARS);
  return pass(forward, (_, p) => size(p) < CHUNK_MIN_CHARS);
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The PDF pages or caption paragraphs a chunk overlaps, as a label. */
export function locate(kind: SourceKind, spans: Span[], start: number, end: number): string | null {
  const first = spans.findIndex((s) => s.start < end && s.end > start);
  if (first === -1) return null;
  let last = first;
  while (spans[last + 1] && (spans[last + 1] as Span).start < end) last++;
  const a = (spans[first] as Span).label;
  const b = (spans[last] as Span).label;
  switch (kind) {
    case "pdf":
      return a === b ? a : `pp. ${a.replace(/^p\. /, "")}–${b.replace(/^p\. /, "")}`;
    case "youtube": {
      // Spans are labelled with their start time, so the chunk ends where the next paragraph starts.
      const until = spans[last + 1]?.label ?? b;
      return a === until ? a : `${a}–${until}`;
    }
    case "article":
      return null;
    default:
      return assertNever(kind);
  }
}

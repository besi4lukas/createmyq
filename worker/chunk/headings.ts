/**
 * STM-17: find section headings in extracted text, per source kind. Pure.
 *
 * - article: the "## Title" lines that worker/extract/article.ts renders for
 *   <h1>…<h6>, only when they stand alone between blank lines (so a "# comment"
 *   inside a code block is not a heading).
 * - pdf: unpdf gives no font information, so only what a heading looks like in
 *   plain text: a numbered section line ("3.1 Execution Overview",
 *   "1. INTRODUCTION") whose number follows the previous heading's, or a line
 *   that is exactly a well-known section name ("Abstract", "References").
 *   Conservative on purpose: a missed heading only makes a citation less
 *   specific, a false one makes it wrong.
 * - youtube: none. Captions have no structure; chunks cite a time range.
 */
import type { SourceKind } from "../extract/result";
import { assertNever } from "../lib/assert";

/** A heading line: [start, end) is the line itself; level 1 is outermost. */
export type Heading = { start: number; end: number; level: number; title: string };

export function findHeadings(kind: SourceKind, text: string): Heading[] {
  switch (kind) {
    case "article":
      return markdownHeadings(text);
    case "pdf":
      return pdfHeadings(text);
    case "youtube":
      return [];
    default:
      return assertNever(kind);
  }
}

type Line = { start: number; end: number; text: string };

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    lines.push({ start, end, text: text.slice(start, end) });
    if (nl === -1) return lines;
    start = nl + 1;
  }
}

/** Long enough for any real heading, short enough to keep body text out. */
const MAX_HEADING_CHARS = 100;

const MARKDOWN_HEADING = /^(#{1,6}) (\S.*)$/;

export function markdownHeadings(text: string): Heading[] {
  const lines = linesOf(text);
  const out: Heading[] = [];
  lines.forEach((line, i) => {
    const m = MARKDOWN_HEADING.exec(line.text);
    if (!m?.[1] || !m[2] || line.text.length > MAX_HEADING_CHARS + 7) return;
    const blankBefore = i === 0 || lines[i - 1]?.text === "";
    const blankAfter = i === lines.length - 1 || lines[i + 1]?.text === "";
    if (!blankBefore || !blankAfter) return;
    out.push({ start: line.start, end: line.end, level: m[1].length, title: m[2].trim() });
  });
  return out;
}

/** "3", "3.1", "4.8.2" (up to four levels), an optional dot, one space, the title. */
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3})(\.?) (\S.*)$/;
/** Unnumbered section names common in papers and reports, as the whole line. */
const KNOWN =
  /^(abstract|introduction|background|related work|conclusions?|summary|acknowledge?ments?|references|bibliography|appendix(?: [A-Z0-9]{1,3})?(?:[.:]? [^.]{1,60})?)$/i;
const MAX_TITLE_WORDS = 12;

export function pdfHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  let prev: number[] | null = null;
  for (const line of linesOf(text)) {
    if (line.text.length > MAX_HEADING_CHARS) continue;
    if (KNOWN.test(line.text)) {
      out.push({ start: line.start, end: line.end, level: 1, title: line.text });
      continue;
    }
    const m = NUMBERED.exec(line.text);
    if (!m?.[1] || m[2] === undefined || !m[3]) continue;
    const number = m[1].split(".").map(Number);
    if (!looksLikeTitle(m[3], m[2] === ".") || !follows(prev, number)) continue;
    prev = number;
    out.push({ start: line.start, end: line.end, level: number.length, title: line.text });
  }
  return out;
}

/**
 * Starts with a capital, mostly words, no sentence punctuation at the end.
 * "1. Reply false if term < currentTerm" is a numbered list item, not a
 * heading, so a dot after the number is only accepted with an ALL-CAPS title
 * ("1. INTRODUCTION", ACM style).
 */
function looksLikeTitle(title: string, dotted: boolean): boolean {
  if (!/^\p{Lu}/u.test(title)) return false;
  if (dotted && /\p{Ll}/u.test(title)) return false;
  if (/[.,;:]$/.test(title)) return false;
  if (title.split(" ").length > MAX_TITLE_WORDS) return false;
  const letters = title.match(/\p{L}/gu)?.length ?? 0;
  return letters >= 3 && letters >= title.replace(/ /g, "").length * 0.6;
}

/**
 * Section numbers only move forward: a child (3 → 3.1), the next sibling
 * (3.1 → 3.2) or a later ancestor's sibling (3.2 → 4, 3.2.1 → 3.3). One
 * skipped number is allowed (a heading we did not recognise), and new levels
 * start at 1. The first heading is 1 (or 1.1 …). This is what keeps figure
 * labels, table rows and reference entries out.
 */
export function follows(prev: number[] | null, next: number[]): boolean {
  const startsAtOne = (parts: number[]) => parts.every((n) => n === 1);
  if (!prev) return startsAtOne(next);
  for (let k = 0; k < next.length; k++) {
    const p = prev[k];
    const n = next[k] as number;
    if (p === undefined) return startsAtOne(next.slice(k)); // a child of prev
    if (n === p) continue;
    const step = n - p;
    return (step === 1 || step === 2) && startsAtOne(next.slice(k + 1));
  }
  return false; // same number again, or an ancestor of prev
}

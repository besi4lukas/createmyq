import { describe, expect, it } from "vitest";
import type { Span } from "../extract";
import {
  bestBreak,
  chunkSource,
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  locate,
  usableTitle,
  type Chunk,
  type ChunkInput,
} from ".";

/** Deterministic filler: sentences of real-looking words, `n` chars or a little more. */
function prose(n: number, seed = 1): string {
  const words = ["service", "data", "the", "cluster", "node", "replica", "writes", "a", "log", "leader", "reads", "of"];
  let s = "";
  let i = seed;
  while (s.length < n) {
    const len = 6 + (i % 9);
    const sentence = Array.from({ length: len }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ");
    s += (s ? " " : "") + sentence[0]?.toUpperCase() + sentence.slice(1) + ".";
    i++;
  }
  return s;
}

/** The invariants every chunking must keep. */
function checkInvariants(input: ChunkInput, chunks: Chunk[]) {
  const { text } = input;
  let prevEnd = 0;
  chunks.forEach((c, i) => {
    expect(c.ordinal).toBe(i);
    expect(c.start).toBeGreaterThanOrEqual(prevEnd);
    expect(c.end).toBeGreaterThan(c.start);
    expect(c.end).toBeLessThanOrEqual(text.length);
    expect(c.end - c.start).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    const slice = text.slice(c.start, c.end);
    expect(slice).toBe(slice.trim()); // trimmed
    expect(text.slice(prevEnd, c.start).trim()).toBe(""); // gaps are whitespace only
    // Never cut mid-word: a chunk boundary sits next to whitespace or the text's edge.
    expect(c.start === 0 || /\s/.test(text[c.start - 1] as string)).toBe(true);
    expect(c.end === text.length || /\s/.test(text[c.end] as string) || /[.!?"')\]]/.test(text[c.end - 1] as string)).toBe(true);
    prevEnd = c.end;
  });
  expect(text.slice(prevEnd).trim()).toBe("");
}

const article = (text: string, title: string | null = "The Article"): ChunkInput => ({ kind: "article", text, title, spans: [] });

describe("chunkSource: articles", () => {
  const text = [
    prose(2000, 1),
    "## Part one",
    prose(300, 2),
    "### Detail A",
    prose(2500, 3),
    "### Detail B",
    prose(14000, 4),
    "## Part two",
    prose(2500, 5),
  ].join("\n\n");
  const input = article(text);
  const chunks = chunkSource(input);

  it("keeps the invariants", () => checkInvariants(input, chunks));

  it("gives the opening the title, and nests heading paths by level", () => {
    expect(chunks[0]?.headingPath).toEqual(["The Article"]);
    const paths = chunks.map((c) => c.headingPath.join(" › "));
    expect(paths).toContain("Part one › Detail B");
    expect(paths.at(-1)).toBe("Part two");
  });

  it("folds a tiny section into the next, keeping the heading they share", () => {
    // "## Part one" has 300 chars before "### Detail A": they become one chunk citing "Part one".
    const partOne = chunks.find((c) => text.slice(c.start, c.end).startsWith("## Part one"));
    expect(partOne?.headingPath).toEqual(["Part one"]);
    expect(text.slice(partOne?.start, partOne?.end)).toContain("### Detail A");
  });

  it("splits a long section into near-equal pieces with the same path", () => {
    const b = chunks.filter((c) => c.headingPath.join(" › ") === "Part one › Detail B");
    expect(b.length).toBeGreaterThanOrEqual(3);
    for (const c of b) expect(c.end - c.start).toBeGreaterThan(CHUNK_MIN_CHARS);
  });

  it("is deterministic", () => {
    expect(chunkSource(article(text))).toEqual(chunks);
  });

  it("returns ranges only, so the step result stays small", () => {
    expect(JSON.stringify(chunks).length).toBeLessThan(text.length / 10);
  });
});

describe("chunkSource: sections that share no heading stay apart", () => {
  it("does not join a short top-level section to its neighbour", () => {
    const text = ["## One", prose(3000, 1), "## Two", prose(400, 2), "## Three", prose(3000, 3)].join("\n\n");
    const chunks = chunkSource(article(text));
    expect(chunks.map((c) => c.headingPath)).toEqual([["One"], ["Two"], ["Three"]]);
  });

  it("but the untitled opening joins the first section", () => {
    const text = ["Title line\nBy Someone", "## Abstract", prose(3000, 1)].join("\n\n");
    const chunks = chunkSource(article(text, null));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual(["Abstract"]);
  });
});

describe("chunkSource: PDFs", () => {
  const pages = [
    `A Paper Title\nSomeone\nAbstract\n${prose(800, 1)}\n1 Introduction\n${prose(2000, 2)}`,
    `${prose(1000, 3)}\n2 Design\n${prose(500, 4)}\n2.1 Storage\n${prose(3000, 5)}`,
    `${prose(2500, 6)}\n2.2 Replication\n${prose(2600, 7)}\nReferences\n[1] A. Person, A book, 1999.`,
  ];
  // As pdf.ts joinPages builds it: pages separated by a blank line, one span each.
  let text = "";
  const spans: Span[] = [];
  pages.forEach((p, i) => {
    if (text) text += "\n\n";
    spans.push({ label: `p. ${i + 1}`, start: text.length, end: text.length + p.length });
    text += p;
  });
  const input: ChunkInput = { kind: "pdf", text, title: "Microsoft Word - paper.docx", spans };
  const chunks = chunkSource(input);

  it("keeps the invariants", () => checkInvariants(input, chunks));

  it("cites numbered sections and page ranges", () => {
    const view = chunks.map((c) => [c.headingPath.join(" › "), c.location]);
    expect(view[0]).toEqual(["Abstract", "p. 1"]); // the untitled opening joined Abstract; the junk title is ignored
    expect(view).toContainEqual(["1 Introduction", "pp. 1–2"]);
    expect(view.some(([path]) => path?.startsWith("2 Design › 2.1 Storage"))).toBe(true);
    expect(view.some(([path, loc]) => path === "2 Design › 2.2 Replication" && loc === "p. 3")).toBe(true);
  });
});

describe("chunkSource: YouTube", () => {
  const paras = Array.from({ length: 30 }, (_, i) => prose(700, i));
  let text = "";
  const spans: Span[] = [];
  paras.forEach((p, i) => {
    if (text) text += "\n\n";
    spans.push({ label: `${Math.floor(i / 2)}:${i % 2 ? "30" : "00"}`, start: text.length, end: text.length + p.length });
    text += p;
  });
  const input: ChunkInput = { kind: "youtube", text, title: "A Talk", spans };
  const chunks = chunkSource(input);

  it("keeps the invariants, breaking only between paragraphs", () => {
    checkInvariants(input, chunks);
    for (const c of chunks.slice(1)) expect(text.slice(c.start - 2, c.start)).toBe("\n\n");
  });

  it("uses the title as the path and a time range as the location", () => {
    expect(new Set(chunks.map((c) => c.headingPath.join()))).toEqual(new Set(["A Talk"]));
    expect(chunks[0]?.location).toMatch(/^0:00–\d+:\d\d$/);
    // Each chunk's range starts where the previous one's ends.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.location?.split("–")[0]).toBe(chunks[i - 1]?.location?.split("–")[1]);
    }
  });

  it("works without a title: an empty path", () => {
    expect(chunkSource({ ...input, title: null }).every((c) => c.headingPath.length === 0)).toBe(true);
  });
});

describe("edge cases", () => {
  it("empty or blank text gives no chunks", () => {
    expect(chunkSource(article(""))).toEqual([]);
    expect(chunkSource(article(" \n\n "))).toEqual([]);
  });

  it("a short text is one chunk", () => {
    const chunks = chunkSource(article("Just one line."));
    expect(chunks).toEqual([{ ordinal: 0, start: 0, end: 14, headingPath: ["The Article"], location: null }]);
  });

  it("text with no breaks at all is still cut within the limit", () => {
    const input = article("x".repeat(20_000));
    const chunks = chunkSource(input);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    expect(chunks.at(-1)?.end).toBe(20_000);
  });

  it("text without punctuation or blank lines (auto captions) breaks at spaces", () => {
    const words = Array.from({ length: 4000 }, (_, i) => ["so", "the", "event", "loop", "runs"][i % 5]).join(" ");
    const input = article(words, null);
    checkInvariants(input, chunkSource(input));
  });

  it("a large source stays well inside the 1 MiB step result", () => {
    const text = Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\n${prose(4000, i)}`).join("\n\n");
    const chunks = chunkSource(article(text));
    checkInvariants(article(text), chunks);
    expect(new TextEncoder().encode(JSON.stringify(chunks)).length).toBeLessThan(64 * 1024);
  });
});

describe("bestBreak", () => {
  it("prefers a blank line, then a sentence end, then a line break, then a space", () => {
    expect(bestBreak("aaa bbb\nccc. Ddd\n\neee", 0, 5, 20)).toBe(16);
    expect(bestBreak("aaa bbb\nccc. Ddd eee", 0, 5, 20)).toBe(12);
    expect(bestBreak("aaa bbb\nccc ddd eee", 0, 5, 20)).toBe(7);
    expect(bestBreak("aaa bbb ccc ddd eee", 0, 5, 20)).toBe(3);
  });

  it("does not treat a decimal point or a lowercase continuation as a sentence end", () => {
    expect(bestBreak("version 1.5 is out e.g. today ok", 0, 10, 30)).toBe(11);
  });
});

describe("locate", () => {
  const pdf: Span[] = [
    { label: "p. 1", start: 0, end: 10 },
    { label: "p. 2", start: 12, end: 20 },
    { label: "p. 3", start: 22, end: 30 },
  ];
  it("names one page or a page range", () => {
    expect(locate("pdf", pdf, 0, 5)).toBe("p. 1");
    expect(locate("pdf", pdf, 5, 25)).toBe("pp. 1–3");
    expect(locate("pdf", pdf, 10, 12)).toBeNull();
  });

  it("gives a time range ending where the next paragraph starts", () => {
    const yt: Span[] = [
      { label: "0:01", start: 0, end: 10 },
      { label: "0:31", start: 12, end: 20 },
      { label: "1:12", start: 22, end: 30 },
    ];
    expect(locate("youtube", yt, 0, 20)).toBe("0:01–1:12");
    expect(locate("youtube", yt, 22, 30)).toBe("1:12");
  });

  it("is null for articles", () => {
    expect(locate("article", [], 0, 10)).toBeNull();
  });
});

describe("usableTitle", () => {
  it("drops authoring-tool file names", () => {
    expect(usableTitle("Microsoft Word - sosp067-decandia1.doc")).toEqual([]);
    expect(usableTitle("paper.pdf")).toEqual([]);
    expect(usableTitle("  ")).toEqual([]);
    expect(usableTitle("In Search of an Understandable Consensus Algorithm")).toEqual([
      "In Search of an Understandable Consensus Algorithm",
    ]);
  });
});

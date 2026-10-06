import { describe, expect, it } from "vitest";
import { makePdf, proseLines, type FakePage } from "../testing/make-pdf";
import { MAX_UPLOAD_BYTES } from "../uploads/upload-rules";
import { extractPdf, joinPages, looksScanned, stripRunningLines } from "./pdf";
import { SCANNED_PDF } from "./result";

const prose = (n: number): FakePage[] => Array.from({ length: n }, (_, i) => ({ lines: proseLines(i + 1) }));

describe("extractPdf", () => {
  it("extracts clean text, a title, page spans and a fingerprint", async () => {
    const r = await extractPdf(makePdf(prose(3), { title: "Consistency notes" }));
    if (!r.ok) throw new Error(r.message);
    expect(r.kind).toBe("pdf");
    expect(r.title).toBe("Consistency notes");
    expect(r.meta.pages).toBe(3);
    expect(r.text.startsWith("Chapter 1: Consistency models\nA distributed system")).toBe(true);
    expect(r.spans.map((s) => s.label)).toEqual(["p. 1", "p. 2", "p. 3"]);
    for (const s of r.spans) expect(r.text.slice(s.start, s.end)).toContain("consistency model");
    expect(r.fingerprint).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("gives the same fingerprint for the same file every time", async () => {
    const pdf = makePdf(prose(2));
    const [a, b] = await Promise.all([extractPdf(pdf), extractPdf(pdf)]);
    expect(a.ok && b.ok && a.fingerprint === b.fingerprint).toBe(true);
  });

  it("accepts exactly 50 pages and refuses 51", async () => {
    const fifty = await extractPdf(makePdf(prose(50)));
    expect(fifty).toMatchObject({ ok: true, meta: { pages: 50 } });
    const fiftyOne = await extractPdf(makePdf(prose(51)));
    expect(fiftyOne).toEqual({
      ok: false,
      code: "too_many_pages",
      message: "This PDF has 51 pages. The limit is 50.",
      retryable: false,
    });
  });

  it("refuses more than 20 MB before parsing", async () => {
    const r = await extractPdf(new Uint8Array(MAX_UPLOAD_BYTES + 1));
    expect(r).toMatchObject({ ok: false, code: "too_large", message: "This file is over 20 MB. Try a smaller PDF." });
  });

  it("fails a scanned (image-only) PDF with the exact message", async () => {
    const r = await extractPdf(makePdf([{ image: true }, { image: true }]));
    expect(r).toEqual({ ok: false, code: "scanned_pdf", message: SCANNED_PDF, retryable: false });
    expect(SCANNED_PDF).toBe("I could not read this file. Scanned PDFs are not supported yet.");
  });

  it("treats a scan with only page numbers as scanned", async () => {
    const pages: FakePage[] = Array.from({ length: 10 }, (_, i) => ({ lines: [`Page ${i + 1}`] }));
    const r = await extractPdf(makePdf(pages));
    expect(r).toMatchObject({ ok: false, code: "scanned_pdf" });
  });

  it("refuses bytes that aren't a PDF", async () => {
    const r = await extractPdf(new TextEncoder().encode("<html>not a pdf</html>"));
    expect(r).toMatchObject({ ok: false, code: "unreadable_pdf" });
    expect(await extractPdf(new Uint8Array())).toMatchObject({ ok: false, code: "unreadable_pdf" });
  });
});

describe("looksScanned", () => {
  it("needs 200 letters overall and 25 per page on average", () => {
    const words = (n: number) => "a".repeat(n);
    expect(looksScanned("", 1)).toBe(true);
    expect(looksScanned(words(199), 1)).toBe(true);
    expect(looksScanned(words(200), 1)).toBe(false);
    expect(looksScanned(words(1000), 50)).toBe(true); // 20 a page: mostly images
    expect(looksScanned(words(1250), 50)).toBe(false);
  });
});

describe("stripRunningLines", () => {
  const words = ["alpha", "bravo", "charlie", "delta", "echo"];
  const body = (n: number) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => `${words[n - 1]} ${words[(n + l) % 5]} line ${l}.`);

  it("drops headers and footers repeated on most pages, digits masked", () => {
    const pages = [1, 2, 3, 4, 5].map((n) => ["Designing Systems \u00B7 Chapter 2", ...body(n), `${n}`].join("\n"));
    pages[2] = ["Designing Systems \u00B7 Chapter 2", "Different body.", ...body(3).slice(1), "Page 3 of 5"].join("\n");
    const out = stripRunningLines(pages);
    expect(out[0]).toBe(body(1).join("\n"));
    expect(out[2]).toBe(["Different body.", ...body(3).slice(1)].join("\n"));
    expect(out[4]).toBe(body(5).join("\n"));
  });

  it("keeps lines in the middle of a page, short pages and short documents", () => {
    const pages = ["Title\nIntro\n42\nmore\nmore\nend"];
    expect(stripRunningLines(pages)).toEqual(pages);
    const short = [1, 2, 3, 4].map((n) => `Header\nLine ${n}\nOther\nMore\n${n}`);
    expect(stripRunningLines(short)).toEqual(short);
  });

  it("never treats a long line as a running header", () => {
    const long = "A".repeat(81);
    const pages = [1, 2, 3, 4].map((n) => [long, ...body(n)].join("\n"));
    expect(stripRunningLines(pages)).toEqual(pages);
  });
});

describe("joinPages", () => {
  it("skips empty pages and records ranges that slice back to each page", () => {
    const { text, spans } = joinPages(["First  page\n", "   ", "Third\n\n\npage"]);
    expect(text).toBe("First page\n\nThird\n\npage");
    expect(spans).toEqual([
      { label: "p. 1", start: 0, end: 10 },
      { label: "p. 3", start: 12, end: 23 },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { findHeadings, follows, markdownHeadings, pdfHeadings } from "./headings";

const titles = (hs: { title: string; level: number }[]) => hs.map((h) => `${h.level}:${h.title}`);

describe("markdownHeadings (articles)", () => {
  it("reads ## lines between blank lines, with their level and exact line range", () => {
    const text = "Intro.\n\n## Part one\n\nBody.\n\n### Detail\n\nMore.";
    const hs = markdownHeadings(text);
    expect(titles(hs)).toEqual(["2:Part one", "3:Detail"]);
    for (const h of hs) expect(text.slice(h.start, h.end)).toMatch(/^#+ /);
  });

  it("ignores a # line glued to other lines (a comment in a code block) and #hashtag text", () => {
    const text = "Run this:\n\n# install deps\nnpm ci\n\n#notaheading\n\n## Real\n\nok";
    expect(titles(markdownHeadings(text))).toEqual(["2:Real"]);
  });

  it("accepts a heading at the very start or end of the text", () => {
    expect(titles(markdownHeadings("# Top\n\nbody\n\n## End"))).toEqual(["1:Top", "2:End"]);
  });
});

describe("follows (PDF section numbering)", () => {
  it.each([
    [null, [1], true],
    [null, [1, 1], true],
    [null, [2], false],
    [[1], [2], true],
    [[1], [1, 1], true],
    [[1], [1, 2], false],
    [[3, 1], [3, 2], true],
    [[3, 6], [4], true],
    [[3, 6], [4, 1], true],
    [[4, 8], [4, 8, 1], true],
    [[4, 8, 3], [4, 9], true],
    [[3, 1], [3, 3], true], // one missed heading
    [[3, 1], [3, 4], false],
    [[3, 1], [3, 1], false],
    [[3, 1], [3], false],
    [[3, 1], [2], false],
    [[5], [378], false],
  ] as const)("%j → %j is %s", (prev, next, ok) => {
    expect(follows(prev ? [...prev] : null, [...next])).toBe(ok);
  });
});

describe("pdfHeadings", () => {
  // Shaped like real unpdf output: headings sit on their own line, with no blank lines around them.
  const paper = [
    "MapReduce: Simplified Data Processing on Large Clusters",
    "Jeffrey Dean and Sanjay Ghemawat",
    "Abstract",
    "MapReduce is a programming model and an associated implementation.",
    "1 Introduction",
    "Over the past five years, the authors have implemented hundreds of",
    "2 Programming Model",
    "The computation takes a set of input key/value pairs.",
    "2.1 Example",
    "Consider the problem of counting the number of occurrences.",
    "Table 1 shows 3 Machines in total.",
    "3 Implementation",
    "1. The MapReduce library in the user program first splits the input",
    "2. One of the copies of the program is special",
    "3.1 Execution Overview",
    "10 GB of memory per machine",
    "3.2 Master Data Structures",
    "4 Refinements",
    "Acknowledgements",
    "We thank Josh Levenberg.",
    "References",
    "[1] Andrea C. Arpaci-Dusseau, Remzi H. Arpaci-Dusseau,",
    "378. Springer-Verlag, 1988.",
  ].join("\n");

  it("finds numbered sections and well-known names, and nothing else", () => {
    expect(titles(pdfHeadings(paper))).toEqual([
      "1:Abstract",
      "1:1 Introduction",
      "1:2 Programming Model",
      "2:2.1 Example",
      "1:3 Implementation",
      "2:3.1 Execution Overview",
      "2:3.2 Master Data Structures",
      "1:4 Refinements",
      "1:Acknowledgements",
      "1:References",
    ]);
  });

  it("accepts ACM style: a dot after the number when the title is ALL CAPS", () => {
    const text = "ABSTRACT\nText.\n1. INTRODUCTION\nText.\n2. BACKGROUND\n2.1 System Assumptions and Requirements\n1. Reply false if term is old";
    expect(titles(pdfHeadings(text))).toEqual([
      "1:ABSTRACT",
      "1:1. INTRODUCTION",
      "1:2. BACKGROUND",
      "2:2.1 System Assumptions and Requirements",
    ]);
  });

  it("rejects sentences, long lines and lowercase starts", () => {
    const text = [
      "1 Introduction",
      "2 the next line starts lower case",
      "2 Programs, as we said,",
      "2 This line is far too long to be a heading because it keeps going with many many more words",
      "2 1 2 3 4 5 6",
    ].join("\n");
    expect(titles(pdfHeadings(text))).toEqual(["1:1 Introduction"]);
  });
});

describe("findHeadings", () => {
  it("YouTube has none, whatever the text looks like", () => {
    expect(findHeadings("youtube", "## Looks like one\n\n1 Introduction")).toEqual([]);
  });
});

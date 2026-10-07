import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_DIR, loadEvalSet, readManifest, sampleChunks, textPath } from "./load";
import { evalEntrySchema, PER_LABEL, setProblems, type EvalManifestEntry } from "./manifest";
import type { Chunk } from "../../worker/chunk";

const good = {
  id: "off-pdf-example",
  label: "refused",
  detected: "cooking",
  topic: "cooking",
  difficulty: "clear",
  kind: "pdf",
  title: "A cookbook",
  source: {
    url: "https://example.gov/cookbook.pdf",
    citation: "Somebody, 2021.",
    licence: "us-government-work",
    retrieved: "2026-10-07",
  },
  storage: "repo",
  rationale: "Recipes.",
};

const accepted = {
  ...good,
  id: "se-article-example",
  label: "accepted",
  detected: null,
  topic: "testing",
  kind: "article",
  source: { ...good.source, url: "https://en.wikipedia.org/wiki/Software_testing", licence: "CC-BY-SA-4.0" },
};

function issues(input: unknown): string[] {
  const r = evalEntrySchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("evalEntrySchema", () => {
  it("accepts a good refused and a good accepted entry", () => {
    expect(issues(good)).toEqual([]);
    expect(issues(accepted)).toEqual([]);
    expect(evalEntrySchema.parse(good)).toMatchObject({ ambiguous: false, synthetic: false });
  });

  it("requires a detected phrase on refused entries, and none on accepted ones", () => {
    expect(issues({ ...good, detected: null })).toEqual([expect.stringMatching(/^detected: a refused entry needs/)]);
    expect(issues({ ...good, detected: "  " })).not.toEqual([]);
    expect(issues({ ...accepted, detected: "testing" })).toEqual([expect.stringMatching(/^detected: an accepted entry/)]);
  });

  it("wants the bare phrase, not the whole message", () => {
    expect(issues({ ...good, detected: "This looks like cooking" })).not.toEqual([]);
    expect(issues({ ...good, detected: "cooking." })).not.toEqual([]);
  });

  it("refuses committed text under a licence that doesn't allow it", () => {
    for (const licence of ["all-rights-reserved", "unknown", "CC-BY-NC-SA-3.0"]) {
      expect(issues({ ...good, source: { ...good.source, licence } })).toEqual([expect.stringMatching(/^storage: licence/)]);
      expect(issues({ ...good, storage: "fetch", source: { ...good.source, licence } })).toEqual([]);
    }
  });

  it("needs an explanation exactly when ambiguous", () => {
    expect(issues({ ...good, ambiguous: true })).toEqual([expect.stringMatching(/^ambiguity:/)]);
    expect(issues({ ...good, ambiguity: "why" })).toEqual([expect.stringMatching(/^ambiguity:/)]);
    expect(issues({ ...good, ambiguous: true, ambiguity: "why" })).toEqual([]);
  });

  it("checks the URL against the kind the product would see", () => {
    expect(issues({ ...accepted, kind: "youtube" })).toEqual([expect.stringMatching(/an article URL on a youtube entry/)]);
    expect(issues({ ...accepted, source: { ...accepted.source, url: "https://youtu.be/8aGhZQkoFbQ" } })).toEqual([
      expect.stringMatching(/a youtube URL on an article entry/),
    ]);
    expect(issues({ ...accepted, source: { ...accepted.source, url: "http://example.com/" } })).not.toEqual([]);
  });

  it("rejects bad ids, unknown labels, kinds, licences and stray keys", () => {
    expect(issues({ ...good, id: "Bad Id" })).not.toEqual([]);
    expect(issues({ ...good, label: "rejected" })).not.toEqual([]);
    expect(issues({ ...good, kind: "epub" })).not.toEqual([]);
    expect(issues({ ...good, source: { ...good.source, licence: "MIT" } })).not.toEqual([]);
    expect(issues({ ...good, extra: 1 })).not.toEqual([]);
    expect(issues({ ...good, source: { ...good.source, retrieved: "yesterday" } })).not.toEqual([]);
  });

  it("keeps synthetic text in the repo", () => {
    expect(issues({ ...good, synthetic: true })).toEqual([]);
    expect(issues({ ...good, synthetic: true, storage: "fetch" })).not.toEqual([]);
  });
});

describe("setProblems", () => {
  const make = (label: "accepted" | "refused", i: number) =>
    evalEntrySchema.parse(label === "accepted" ? { ...accepted, id: `a-${i}` } : { ...good, id: `r-${i}` });
  const balanced = [
    ...Array.from({ length: PER_LABEL }, (_, i) => make("accepted", i)),
    ...Array.from({ length: PER_LABEL }, (_, i) => make("refused", i)),
  ];

  it("passes a balanced set with unique ids", () => {
    expect(setProblems(balanced)).toEqual([]);
  });

  it("reports duplicates and imbalance", () => {
    expect(setProblems([...balanced, balanced[0]!])).toEqual(["duplicate id a-0", `${PER_LABEL + 1} accepted entries, expected ${PER_LABEL}`]);
    expect(setProblems(balanced.slice(1))).toEqual([`${PER_LABEL - 1} accepted entries, expected ${PER_LABEL}`]);
  });
});

describe("the committed manifest", () => {
  it("is valid, 25/25, with unique ids", async () => {
    const { entries } = await readManifest();
    expect(entries).toHaveLength(2 * PER_LABEL);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(entries.filter((e) => e.label === "accepted")).toHaveLength(PER_LABEL);
    expect(entries.filter((e) => e.label === "refused")).toHaveLength(PER_LABEL);
  });

  it("gives every refused entry a detected phrase", async () => {
    const { entries } = await readManifest();
    for (const e of entries.filter((x) => x.label === "refused")) expect(e.detected, e.id).toMatch(/\S/);
  });

  it("covers every kind for both labels, plus clear and borderline cases", async () => {
    const { entries } = await readManifest();
    for (const label of ["accepted", "refused"] as const) {
      for (const kind of ["pdf", "article", "youtube"] as const) {
        expect(entries.some((e) => e.label === label && e.kind === kind), `${label} ${kind}`).toBe(true);
      }
      for (const difficulty of ["clear", "borderline"] as const) {
        expect(entries.some((e) => e.label === label && e.difficulty === difficulty), `${label} ${difficulty}`).toBe(true);
      }
    }
  });

  it("includes STM-22's case: a cooking PDF refused as cooking", async () => {
    const { entries } = await readManifest();
    expect(entries.some((e) => e.kind === "pdf" && e.label === "refused" && e.detected === "cooking")).toBe(true);
  });

  it("has committed text for every repo entry and none for fetch entries", async () => {
    const { entries } = await readManifest();
    for (const e of entries) expect(existsSync(textPath(EVAL_DIR, e.id)), e.id).toBe(e.storage === "repo");
  });
});

describe("loadEvalSet", () => {
  it("loads committed text offline, with chunks and start/middle/end samples", async () => {
    const { entries } = await readManifest();
    const repoIds = entries.filter((e) => e.storage === "repo").map((e) => e.id);
    const loaded = await loadEvalSet({ offline: true, only: repoIds });
    expect(loaded.failures).toEqual([]);
    expect(loaded.entries).toHaveLength(repoIds.length);
    for (const e of loaded.entries) {
      expect(e.origin).toBe("repo");
      expect(e.text.length, e.id).toBeGreaterThan(1000);
      expect(e.fingerprint).toMatch(/^v1:[0-9a-f]{64}$/);
      expect(e.samples.length).toBeGreaterThanOrEqual(1);
      expect(e.samples[0]!.position).toBe("start");
    }
  });

  it("reports a missing text file and an uncached fetch entry offline as failures, not throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-"));
    const manifest = JSON.parse(await readFile(join(EVAL_DIR, "manifest.json"), "utf8")) as { entries: EvalManifestEntry[] };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    await mkdir(join(dir, "text"));
    const fetchEntry = manifest.entries.find((e) => e.storage === "fetch")!;
    const repoEntry = manifest.entries.find((e) => e.storage === "repo")!;
    const { entries, failures } = await loadEvalSet({ dir, offline: true, only: [fetchEntry.id, repoEntry.id, "nope"] });
    expect(entries).toEqual([]);
    expect(failures).toEqual(
      expect.arrayContaining([
        { id: "nope", message: "no such entry" },
        { id: fetchEntry.id, message: "not cached and offline" },
        { id: repoEntry.id, message: expect.stringMatching(/^missing .*eval:snapshot/) },
      ]),
    );
  });

  it("throws on an invalid manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-"));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 1, entries: [good] }));
    await expect(loadEvalSet({ dir, offline: true })).rejects.toThrow(/1 refused entries, expected 25/);
  });
});

describe("sampleChunks", () => {
  const chunk = (ordinal: number): Chunk => ({ ordinal, start: ordinal * 10, end: ordinal * 10 + 5, headingPath: [], location: null });
  const text = "x".repeat(100);

  it("takes the first, middle and last chunk", () => {
    expect(sampleChunks(text, [0, 1, 2, 3, 4].map(chunk)).map((s) => [s.position, s.chunk.ordinal])).toEqual([
      ["start", 0],
      ["middle", 2],
      ["end", 4],
    ]);
  });

  it("never repeats a chunk", () => {
    expect(sampleChunks(text, [chunk(0)]).map((s) => s.position)).toEqual(["start"]);
    expect(sampleChunks(text, [0, 1].map(chunk)).map((s) => s.position)).toEqual(["start", "end"]);
    expect(sampleChunks(text, [])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { fakeEmbedder, towards, type EmbedCall } from "../testing/fake-classifier-backends";
import {
  aggregate,
  CLASSIFY_INSTRUCTION,
  confidenceFromMargin,
  cosine,
  EmbeddingClassifier,
  FULL_CONFIDENCE_MARGIN,
  MAX_SAMPLE_CHARS,
  scoreSample,
  verdictFromMargin,
  type LabelVectors,
} from "./embedding";
import { ACCEPT_LABELS, REFUSE_LABELS } from "./labels";

const labels: LabelVectors = {
  accept: [
    { label: { id: "a1", text: "" }, vector: [1, 0, 0, 0] },
    { label: { id: "a2", text: "" }, vector: [0, 1, 0, 0] },
  ],
  refuse: [
    { label: { id: "r1", detected: "cooking", text: "" }, vector: [0, 0, 1, 0] },
    { label: { id: "r2", detected: "music", text: "" }, vector: [0, 0, 0, 1] },
  ],
};

describe("cosine", () => {
  it("is 1 for parallel, 0 for orthogonal, −1 for opposite, and scale-free", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0);
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
  });
  it("is 0 for a zero vector and throws on mismatched lengths", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(() => cosine([1], [1, 2])).toThrow();
  });
});

describe("scoreSample", () => {
  it("takes the best accept and best refuse label and their difference", () => {
    const s = scoreSample([0.2, 0.9, 0.3, 0], labels);
    expect(s.accept.id).toBe("a2");
    expect(s.refuse).toMatchObject({ id: "r1", detected: "cooking" });
    expect(s.margin).toBeCloseTo(s.accept.score - s.refuse.score);
    expect(s.margin).toBeGreaterThan(0);
  });
  it("is negative when a refusal label is closer", () => {
    expect(scoreSample([0.1, 0, 0, 1], labels).margin).toBeLessThan(0);
  });
});

describe("aggregate, verdict and confidence", () => {
  it("averages the per-sample margins", () => {
    const s = (margin: number) => ({ accept: { id: "a", score: 0 }, refuse: { id: "r", detected: "x", score: 0 }, margin });
    expect(aggregate([s(0.1), s(-0.04), s(0.03)]).margin).toBeCloseTo(0.03);
    expect(() => aggregate([])).toThrow();
  });
  it("accepts at margin 0 and above, refuses below", () => {
    expect(verdictFromMargin(0)).toBe("accepted");
    expect(verdictFromMargin(0.001)).toBe("accepted");
    expect(verdictFromMargin(-0.001)).toBe("refused");
  });
  it("is 0.5 at margin 0, linear in |margin|, and 1 from the full-confidence margin on", () => {
    expect(confidenceFromMargin(0)).toBe(0.5);
    expect(confidenceFromMargin(FULL_CONFIDENCE_MARGIN / 2)).toBeCloseTo(0.75);
    expect(confidenceFromMargin(-FULL_CONFIDENCE_MARGIN / 2)).toBeCloseTo(0.75);
    expect(confidenceFromMargin(FULL_CONFIDENCE_MARGIN)).toBe(1);
    expect(confidenceFromMargin(-5)).toBe(1);
  });
});

describe("EmbeddingClassifier", () => {
  it("accepts samples close to a software-engineering label", async () => {
    const calls: EmbedCall[] = [];
    const c = new EmbeddingClassifier(fakeEmbedder(() => towards({ databases: 1, cooking: 0.2 }), calls));
    const r = await c.classify(["a", "b", "c"]);
    expect(r).toMatchObject({ verdict: "accepted", detected: null, by: "embedding" });
    expect(r.confidence).toBe(1);
    expect(r.embedding!.samples).toHaveLength(3);
    expect(r.costUsd).toBeCloseTo(0.00003);
    // Samples as instructed queries, labels as documents, in label order.
    expect(calls.find((x) => x.kind === "queries")).toMatchObject({ texts: ["a", "b", "c"], instruction: CLASSIFY_INSTRUCTION });
    expect(calls.find((x) => x.kind === "documents")!.texts).toEqual([...ACCEPT_LABELS, ...REFUSE_LABELS].map((l) => l.text));
  });

  it("refuses and names the refusal label with the best mean score across samples", async () => {
    // Sample 1 leans gardening, samples 2–3 lean cooking: cooking wins on the mean.
    const vec: Record<string, number[]> = {
      s1: towards({ gardening: 1, cooking: 0.6 }),
      s2: towards({ cooking: 1, gardening: 0.1 }),
      s3: towards({ cooking: 1, "software-engineering": 0.2 }),
    };
    const r = await new EmbeddingClassifier(fakeEmbedder((s) => vec[s]!)).classify(["s1", "s2", "s3"]);
    expect(r.verdict).toBe("refused");
    expect(r.detected).toBe("cooking");
    expect(r.embedding!.samples[0]!.refuse.id).toBe("gardening");
  });

  it("is unsure when the margin is small", async () => {
    const r = await new EmbeddingClassifier(fakeEmbedder(() => towards({ "software-engineering": 1, "product-management": 0.98 }))).classify(["x"]);
    expect(r.verdict).toBe("accepted");
    expect(r.confidence).toBeLessThan(0.6);
  });

  it("cuts long samples, drops blank ones, and throws when nothing is left", async () => {
    const calls: EmbedCall[] = [];
    const c = new EmbeddingClassifier(fakeEmbedder(() => towards({ databases: 1 }), calls));
    await c.classify(["x".repeat(MAX_SAMPLE_CHARS + 500), "   "]);
    expect(calls.find((x) => x.kind === "queries")!.texts.map((t) => t.length)).toEqual([MAX_SAMPLE_CHARS]);
    await expect(c.classify([" ", ""])).rejects.toThrow(/no non-empty samples/);
  });

  it("throws when the embedder returns the wrong number of vectors", async () => {
    const c = new EmbeddingClassifier(async () => ({ vectors: [], costUsd: 0 }));
    await expect(c.classify(["x"])).rejects.toThrow(/wrong number/);
  });
});

describe("labels", () => {
  it("have unique ids, and every refusal label has a bare detected phrase", () => {
    const ids = [...ACCEPT_LABELS, ...REFUSE_LABELS].map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of REFUSE_LABELS) expect(l.detected).toMatch(/^[a-z][a-z -]*[a-z]$/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPT_LABELS, REFUSE_LABELS } from "../../worker/classifier/labels";
import type { Classification } from "../../worker/classifier/types";
import { EVAL_DIR } from "./load";
import {
  accuracy,
  chooseThreshold,
  confusion,
  detectedMatches,
  detectedRate,
  isCorrect,
  leaveOneOut,
  normalisePhrase,
  percentile,
  simulate,
  sweep,
  type BenchRow,
  type SweepInput,
} from "./metrics";

function row(id: string, label: "accepted" | "refused", verdict: "accepted" | "refused" | null, extra: Partial<BenchRow> = {}, detected: string | null = null): BenchRow {
  const result: Classification | null =
    verdict === null
      ? null
      : { verdict, confidence: 0.9, detected, by: "embedding", usage: { inputTokens: 0, outputTokens: 0, embeddedChars: 1 }, costUsd: 0 };
  return { id, label, ambiguous: false, detected: label === "refused" ? "cooking" : null, detectedSynonyms: [], result, error: verdict ? null : "boom", ms: 1, ...extra };
}

describe("accuracy and confusion", () => {
  const rows = [
    row("a", "accepted", "accepted"),
    row("b", "accepted", "refused"),
    row("c", "refused", "refused"),
    row("d", "refused", "accepted"),
    row("e", "refused", null),
    row("f", "accepted", "accepted", { ambiguous: true }),
  ];
  it("splits unambiguous / ambiguous / overall and counts errors as misses", () => {
    expect(accuracy(rows, "unambiguous", isCorrect)).toEqual({ correct: 2, total: 5, rate: 0.4 });
    expect(accuracy(rows, "ambiguous", isCorrect)).toEqual({ correct: 1, total: 1, rate: 1 });
    expect(accuracy(rows, "overall", isCorrect).correct).toBe(3);
  });
  it("treats refused as the positive class", () => {
    expect(confusion(rows)).toEqual({ tp: 1, fp: 1, fn: 1, tn: 2, errors: 1, refusedPrecision: 0.5, refusedRecall: 0.5 });
  });
});

describe("detected phrase matching", () => {
  it("normalises case, punctuation, articles and the message prefix", () => {
    expect(normalisePhrase("This looks like  The Music-Theory!")).toBe("music theory");
    expect(normalisePhrase("R&D")).toBe("r and d");
  });
  it("matches equal phrases, synonyms and whole-word containment, not substrings", () => {
    expect(detectedMatches("Cooking", ["cooking"])).toBe(true);
    expect(detectedMatches("soccer", ["football", "soccer"])).toBe(true);
    expect(detectedMatches("office software help", ["office software"])).toBe(true);
    expect(detectedMatches("baking and cooking", ["cooking"])).toBe(true);
    expect(detectedMatches("history", ["medieval history"])).toBe(true);
    expect(detectedMatches("physics", ["astrophysics"])).toBe(false);
    expect(detectedMatches("", ["cooking"])).toBe(false);
    expect(detectedMatches("law and politics", ["fiction", "a novel"])).toBe(false);
  });
  it("scores only refused entries predicted refused", () => {
    const rows = [row("a", "refused", "refused", {}, "food"), row("b", "refused", "refused", {}, "cars"), row("c", "refused", "accepted"), row("d", "accepted", "refused", {}, "x")];
    rows[0]!.detectedSynonyms = ["food"];
    expect(detectedRate(rows)).toEqual({ matched: 1, total: 2, rate: 0.5 });
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const xs = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("threshold sweep and cross-validation", () => {
  const e = (id: string, label: "accepted" | "refused", emb: "accepted" | "refused", conf: number, model: "accepted" | "refused", ambiguous = false): SweepInput => ({
    id,
    label,
    ambiguous,
    embedding: { verdict: emb, confidence: conf, costUsd: 0.0001 },
    model: { verdict: model, costUsd: 0.003 },
  });
  // The embedding is wrong only when unsure (0.6); the model is right there.
  const inputs = [
    e("a", "accepted", "accepted", 1, "accepted"),
    e("b", "refused", "refused", 0.95, "refused"),
    e("c", "accepted", "refused", 0.6, "accepted"),
    e("d", "refused", "refused", 0.7, "accepted"),
    e("amb", "refused", "accepted", 0.55, "refused", true),
  ];

  it("simulates the fallback at a threshold", () => {
    expect(simulate(inputs[2]!, 0.6)).toMatchObject({ verdict: "refused", fellThrough: false });
    expect(simulate(inputs[2]!, 0.65)).toMatchObject({ verdict: "accepted", fellThrough: true, costUsd: 0.0031 });
  });

  it("reports accuracy and fallback rate per threshold", () => {
    const [never, mid, always] = sweep(inputs, [0.5, 0.65, 1.01]);
    expect(never).toMatchObject({ unambiguous: { correct: 3, total: 4 }, fallbackRate: 0 });
    expect(mid).toMatchObject({ unambiguous: { correct: 4, total: 4 }, ambiguous: { correct: 1, total: 1 }, fallbackRate: 0.4 });
    expect(always).toMatchObject({ unambiguous: { correct: 3, total: 4 }, fallbackRate: 1 });
  });

  it("chooses the most accurate threshold on unambiguous entries, ties to the lowest", () => {
    expect(chooseThreshold(inputs, [0.5, 0.65, 0.68, 1.01])).toBe(0.65);
  });

  it("leave-one-out chooses on the others and scores the held-out entry", () => {
    const loo = leaveOneOut(inputs, [0.5, 0.65, 1.01]);
    expect(loo.total).toBe(4);
    // Holding out "c" leaves nothing that needs a fallback, so t = 0.5 is chosen and "c" is missed.
    expect(loo.correct).toBe(3);
    expect(loo.thresholds).toHaveLength(4);
  });
});

describe("no leakage from the evaluation set into the labels", () => {
  it("no label description contains an evaluation entry's title", () => {
    const manifest = JSON.parse(readFileSync(join(EVAL_DIR, "manifest.json"), "utf8")) as { entries: { title: string }[] };
    const texts = [...ACCEPT_LABELS, ...REFUSE_LABELS].map((l) => l.text.toLowerCase());
    for (const { title } of manifest.entries) {
      for (const t of texts) expect(t.includes(title.toLowerCase())).toBe(false);
    }
  });
});

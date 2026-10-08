/**
 * STM-21: scoring for the classifier benchmark (bench.ts). Pure functions over
 * benchmark rows; no I/O.
 *
 * Accuracy is reported on three subsets: the unambiguous entries (the
 * headline; the 90% gate), the `ambiguous` ones (proposed labels, not yet
 * ruled on) and all of them. "Positive" in the confusion matrix is `refused`,
 * the decision that blocks a user. A classifier error counts as a miss.
 */
import type { Classification } from "../../worker/classifier/types";

export type BenchRow = {
  id: string;
  label: "accepted" | "refused";
  ambiguous: boolean;
  /** Expected phrase and its synonyms (refused only). */
  detected: string | null;
  detectedSynonyms: string[];
  result: Classification | null;
  error: string | null;
  /** Time inside the harness Worker (classify only). */
  ms: number;
};

export type Subset = "unambiguous" | "ambiguous" | "overall";

export function inSubset(row: { ambiguous: boolean }, subset: Subset): boolean {
  return subset === "overall" || (subset === "ambiguous") === row.ambiguous;
}

export function isCorrect(row: BenchRow): boolean {
  return row.result !== null && row.result.verdict === row.label;
}

export type Accuracy = { correct: number; total: number; rate: number };

export function accuracy<R extends { ambiguous: boolean }>(rows: readonly R[], subset: Subset, correct: (r: R) => boolean): Accuracy {
  const picked = rows.filter((r) => inSubset(r, subset));
  const n = picked.filter(correct).length;
  return { correct: n, total: picked.length, rate: picked.length === 0 ? 0 : n / picked.length };
}

export type Confusion = {
  /** refused predicted refused */
  tp: number;
  /** accepted predicted refused (a software source blocked) */
  fp: number;
  /** refused predicted accepted (off-topic let through) */
  fn: number;
  tn: number;
  errors: number;
  refusedPrecision: number;
  refusedRecall: number;
};

export function confusion(rows: readonly BenchRow[]): Confusion {
  let tp = 0, fp = 0, fn = 0, tn = 0, errors = 0;
  for (const r of rows) {
    if (r.result === null) {
      errors++;
      continue;
    }
    const predRefused = r.result.verdict === "refused";
    if (r.label === "refused") {
      if (predRefused) tp++;
      else fn++;
    } else if (predRefused) fp++;
    else tn++;
  }
  return { tp, fp, fn, tn, errors, refusedPrecision: tp + fp === 0 ? 0 : tp / (tp + fp), refusedRecall: tp + fn === 0 ? 0 : tp / (tp + fn) };
}

/**
 * Lowercase; "&" → "and"; punctuation → space; leading "a"/"an"/"the" and
 * "this looks like" dropped; whitespace collapsed.
 */
export function normalisePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^this looks like /, "")
    .replace(/^(a|an|the) /, "")
    .trim();
}

/**
 * A detected phrase matches when, normalised, it equals the expected phrase
 * or a synonym, or one contains the other as whole words ("office software
 * help" ⊃ "office software", "baking and cooking" ⊃ "cooking").
 */
export function detectedMatches(got: string, expected: readonly string[]): boolean {
  const g = normalisePhrase(got);
  if (g.length === 0) return false;
  return expected.some((e) => {
    const x = normalisePhrase(e);
    if (x.length === 0) return false;
    return g === x || ` ${g} `.includes(` ${x} `) || ` ${x} `.includes(` ${g} `);
  });
}

/** Over refused entries that were predicted refused: how many named the topic acceptably. */
export function detectedRate(rows: readonly BenchRow[]): { matched: number; total: number; rate: number } {
  const scored = rows.filter((r) => r.label === "refused" && r.result?.verdict === "refused" && r.detected !== null);
  const matched = scored.filter((r) => detectedMatches(r.result!.detected ?? "", [r.detected!, ...r.detectedSynonyms])).length;
  return { matched, total: scored.length, rate: scored.length === 0 ? 0 : matched / scored.length };
}

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

// ---------------------------------------------------------------------------
// Threshold sweep for the fallback, simulated from the embedding and model
// runs: embedding confidence ≥ t keeps the embedding verdict, otherwise the
// model's verdict is used. (The real fallback run at the chosen threshold is
// reported separately; it can differ slightly because Haiku is re-asked.)

export type SweepInput = {
  id: string;
  label: "accepted" | "refused";
  ambiguous: boolean;
  embedding: { verdict: "accepted" | "refused"; confidence: number; costUsd: number };
  model: { verdict: "accepted" | "refused"; costUsd: number };
};

/** 0.5 (never fall through) … 1.0 in steps of 0.025, then 1.01 (always). */
export const SWEEP_THRESHOLDS: readonly number[] = [...Array.from({ length: 21 }, (_, i) => Math.round((0.5 + i * 0.025) * 1000) / 1000), 1.01];

export function simulate(e: SweepInput, threshold: number): { verdict: "accepted" | "refused"; fellThrough: boolean; costUsd: number } {
  if (e.embedding.confidence >= threshold) return { verdict: e.embedding.verdict, fellThrough: false, costUsd: e.embedding.costUsd };
  return { verdict: e.model.verdict, fellThrough: true, costUsd: e.embedding.costUsd + e.model.costUsd };
}

export type SweepRow = {
  threshold: number;
  unambiguous: Accuracy;
  ambiguous: Accuracy;
  overall: Accuracy;
  fallbackRate: number;
  costPerSource: number;
};

export function sweep(inputs: readonly SweepInput[], thresholds: readonly number[] = SWEEP_THRESHOLDS): SweepRow[] {
  return thresholds.map((threshold) => {
    const sims = inputs.map((e) => ({ ...e, sim: simulate(e, threshold) }));
    const correct = (r: (typeof sims)[number]) => r.sim.verdict === r.label;
    return {
      threshold,
      unambiguous: accuracy(sims, "unambiguous", correct),
      ambiguous: accuracy(sims, "ambiguous", correct),
      overall: accuracy(sims, "overall", correct),
      fallbackRate: sims.length === 0 ? 0 : sims.filter((r) => r.sim.fellThrough).length / sims.length,
      costPerSource: sims.length === 0 ? 0 : sims.reduce((n, r) => n + r.sim.costUsd, 0) / sims.length,
    };
  });
}

/**
 * The rule used to pick the threshold: highest accuracy on the unambiguous
 * entries; ties go to the lowest threshold (fewest model calls).
 */
export function chooseThreshold(inputs: readonly SweepInput[], thresholds: readonly number[] = SWEEP_THRESHOLDS): number {
  const unambiguous = inputs.filter((e) => !e.ambiguous);
  let best = { threshold: thresholds[0]!, correct: -1 };
  for (const t of thresholds) {
    const correct = unambiguous.filter((e) => simulate(e, t).verdict === e.label).length;
    if (correct > best.correct) best = { threshold: t, correct };
  }
  return best.threshold;
}

/**
 * Leave-one-out check of the threshold rule on the unambiguous entries: for
 * each entry, choose the threshold on the other entries, then classify the
 * held-out one with it. An honest estimate of the chosen setup's accuracy.
 */
export function leaveOneOut(inputs: readonly SweepInput[], thresholds: readonly number[] = SWEEP_THRESHOLDS): Accuracy & { thresholds: number[] } {
  const unambiguous = inputs.filter((e) => !e.ambiguous);
  let correct = 0;
  const chosen: number[] = [];
  unambiguous.forEach((held, i) => {
    const t = chooseThreshold(
      unambiguous.filter((_, j) => j !== i),
      thresholds,
    );
    chosen.push(t);
    if (simulate(held, t).verdict === held.label) correct++;
  });
  return { correct, total: unambiguous.length, rate: unambiguous.length === 0 ? 0 : correct / unambiguous.length, thresholds: chosen };
}

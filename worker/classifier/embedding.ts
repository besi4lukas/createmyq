/**
 * STM-21: the embedding classifier. Each sample and each label description
 * (labels.ts) is embedded; a sample's margin is its best software-engineering
 * similarity minus its best refusal similarity; the source's margin is the
 * mean over its samples. Positive → accepted. Confidence grows with the size
 * of the margin. The refusal label that scores best on average names
 * `detected`.
 *
 * Cost: one embedding call for the samples (~15k chars, ~$0.00005) and one
 * for the labels (~4k chars), about $0.00006 per source.
 */
import { ACCEPT_LABELS, REFUSE_LABELS, type AcceptLabel, type RefuseLabel } from "./labels";
import { requireSamples, type Classification, type Classifier, type EmbeddingScores, type SampleScore } from "./types";

/** What the classifier needs from an embedding model (backends.ts: Workers AI Qwen3). */
export type Embedder = (
  input: { queries: string[]; instruction: string } | { documents: string[] },
) => Promise<{ vectors: number[][]; costUsd: number }>;

/** The task instruction for the samples (Qwen3 queries); labels are embedded as plain documents. */
export const CLASSIFY_INSTRUCTION = "Given a passage from a document, retrieve the subject area the document is about";

/** Samples are cut to this many characters before embedding (chunks are ≤ 6,000; this keeps the call small). */
export const MAX_SAMPLE_CHARS = 4000;

/**
 * A mean margin of this size (cosine units) or more is full confidence (1);
 * zero is a coin toss (0.5). Fixed before the benchmark; the fallback
 * threshold is chosen on confidence, so this only sets the scale.
 */
export const FULL_CONFIDENCE_MARGIN = 0.1;

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`vector lengths differ: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export type LabelVectors = {
  accept: { label: AcceptLabel; vector: number[] }[];
  refuse: { label: RefuseLabel; vector: number[] }[];
};

/** Best accept label, best refusal label and the margin between them, for one sample. */
export function scoreSample(vector: readonly number[], labels: LabelVectors): SampleScore {
  if (labels.accept.length === 0 || labels.refuse.length === 0) throw new Error("need at least one accept and one refuse label");
  let accept = { id: "", score: -Infinity };
  for (const { label, vector: v } of labels.accept) {
    const score = cosine(vector, v);
    if (score > accept.score) accept = { id: label.id, score };
  }
  let refuse = { id: "", detected: "", score: -Infinity };
  for (const { label, vector: v } of labels.refuse) {
    const score = cosine(vector, v);
    if (score > refuse.score) refuse = { id: label.id, detected: label.detected, score };
  }
  return { accept, refuse, margin: accept.score - refuse.score };
}

/**
 * The refusal label with the highest mean similarity across all samples
 * (not just each sample's winner), so one odd chunk can't name the topic.
 */
export function detectedTopic(sampleVectors: readonly (readonly number[])[], labels: LabelVectors): RefuseLabel {
  let best: { label: RefuseLabel; score: number } | null = null;
  for (const { label, vector } of labels.refuse) {
    const score = sampleVectors.reduce((sum, v) => sum + cosine(v, vector), 0) / sampleVectors.length;
    if (best === null || score > best.score) best = { label, score };
  }
  if (best === null) throw new Error("need at least one refuse label");
  return best.label;
}

export function aggregate(samples: readonly SampleScore[]): EmbeddingScores {
  if (samples.length === 0) throw new Error("no samples to aggregate");
  return { samples: [...samples], margin: samples.reduce((sum, s) => sum + s.margin, 0) / samples.length };
}

/** A margin of exactly 0 is accepted: refusing is the costlier mistake for a user. */
export function verdictFromMargin(margin: number): "accepted" | "refused" {
  return margin >= 0 ? "accepted" : "refused";
}

/** 0.5 at margin 0, rising linearly to 1 at ±FULL_CONFIDENCE_MARGIN. */
export function confidenceFromMargin(margin: number, full = FULL_CONFIDENCE_MARGIN): number {
  return 0.5 + 0.5 * Math.min(1, Math.abs(margin) / full);
}

export class EmbeddingClassifier implements Classifier {
  constructor(private readonly embed: Embedder) {}

  async classify(samples: readonly string[]): Promise<Classification> {
    const texts = requireSamples(samples).map((s) => s.slice(0, MAX_SAMPLE_CHARS));
    const labelTexts = [...ACCEPT_LABELS, ...REFUSE_LABELS].map((l) => l.text);
    const [s, l] = await Promise.all([
      this.embed({ queries: texts, instruction: CLASSIFY_INSTRUCTION }),
      this.embed({ documents: labelTexts }),
    ]);
    if (s.vectors.length !== texts.length || l.vectors.length !== labelTexts.length) throw new Error("embedder returned the wrong number of vectors");
    const labels: LabelVectors = {
      accept: ACCEPT_LABELS.map((label, i) => ({ label, vector: l.vectors[i]! })),
      refuse: REFUSE_LABELS.map((label, i) => ({ label, vector: l.vectors[ACCEPT_LABELS.length + i]! })),
    };
    const scores = aggregate(s.vectors.map((v) => scoreSample(v, labels)));
    const verdict = verdictFromMargin(scores.margin);
    return {
      verdict,
      confidence: confidenceFromMargin(scores.margin),
      detected: verdict === "refused" ? detectedTopic(s.vectors, labels).detected : null,
      by: "embedding",
      usage: { inputTokens: 0, outputTokens: 0, embeddedChars: [...texts, ...labelTexts].reduce((n, t) => n + t.length, 0) },
      costUsd: s.costUsd + l.costUsd,
      embedding: scores,
    };
  }
}

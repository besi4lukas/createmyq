/**
 * STM-21: the topic gate's contract. A classifier reads a few sampled chunks
 * of one source (STM-22 samples the first, middle and last chunk) and decides
 * whether the source is software engineering. Implementations:
 *
 *   embedding.ts  EmbeddingClassifier: Workers AI embeddings vs fixed label descriptions
 *   model.ts      ModelClassifier: one claude-haiku-4-5 call
 *   fallback.ts   FallbackClassifier: one, then the other when the first is unsure
 *
 * The active one is chosen in index.ts (one line). No I/O here: backends are
 * functions passed in (backends.ts in the Worker, fakes in the tests).
 */

/** Same values as `classification_decisions.gate_verdict`. */
export type Verdict = "accepted" | "refused";

/** Who made the final call. Also what STM-22 writes to `classification_decisions.classified_by`. */
export type ClassifiedBy = "embedding" | "model";

export type ClassifierUsage = {
  /** Model tokens (Haiku). */
  inputTokens: number;
  outputTokens: number;
  /** Characters sent to the embedding model (Workers AI reports no tokens). */
  embeddedChars: number;
};

export const NO_USAGE: ClassifierUsage = { inputTokens: 0, outputTokens: 0, embeddedChars: 0 };

export function addUsage(a: ClassifierUsage, b: ClassifierUsage): ClassifierUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    embeddedChars: a.embeddedChars + b.embeddedChars,
  };
}

/** Per-sample embedding scores: the decision's inputs, for the record STM-22 keeps. */
export type SampleScore = {
  /** Best software-engineering label and its cosine similarity. */
  accept: { id: string; score: number };
  /** Best refusal label, its phrase and its cosine similarity. */
  refuse: { id: string; detected: string; score: number };
  /** accept.score − refuse.score. Positive leans software engineering. */
  margin: number;
};

export type EmbeddingScores = {
  samples: SampleScore[];
  /** Mean of the per-sample margins: the number the verdict and confidence come from. */
  margin: number;
};

export type Classification = {
  verdict: Verdict;
  /** 0.5–1: how sure the classifier that decided is of `verdict`. */
  confidence: number;
  /** Refused only: fills "This looks like {detected}." Null when accepted. */
  detected: string | null;
  by: ClassifiedBy;
  /** Totals for everything this classification called, including a primary that fell through. */
  usage: ClassifierUsage;
  costUsd: number;
  /** Set when embeddings were computed (by the embedding classifier, or as the primary of a fallback). */
  embedding?: EmbeddingScores;
  /** FallbackClassifier only: what the primary said before it fell through. */
  primary?: Omit<Classification, "primary">;
};

export interface Classifier {
  /** Throws when the samples are empty or a backend fails (the Workflow step retries). */
  classify(samples: readonly string[]): Promise<Classification>;
}

export function requireSamples(samples: readonly string[]): string[] {
  const texts = samples.map((s) => s.trim()).filter((s) => s.length > 0);
  if (texts.length === 0) throw new Error("nothing to classify: no non-empty samples");
  return texts;
}

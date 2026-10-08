/**
 * STM-21: the topic gate's classifiers and the one place the active one is
 * chosen. STM-22 calls classifierFor(env) (backends.ts) and never names an
 * implementation itself, so swapping is the one line below.
 *
 * Benchmark: npm run eval:bench (fixtures/eval/results/STM-21.md).
 */
import { assertNever } from "../lib/assert";
import type { ModelCall } from "../workflows/generate";
import { EmbeddingClassifier, type Embedder } from "./embedding";
import { FallbackClassifier } from "./fallback";
import { ModelClassifier } from "./model";
import type { Classifier } from "./types";

export const CLASSIFIER_KINDS = ["embedding", "model", "fallback"] as const;
export type ClassifierKind = (typeof CLASSIFIER_KINDS)[number];

/** The active classifier. Change this line to swap. */
export const ACTIVE_CLASSIFIER: ClassifierKind = "fallback";

/**
 * Embedding confidence below this falls through to the model (fallback only).
 * Chosen on the evaluation set, cross-validated: see fixtures/eval/results/STM-21.md.
 */
export const FALLBACK_THRESHOLD = 0.9;

export type ClassifierBackends = { embed: Embedder; model: ModelCall };

export function makeClassifier(kind: ClassifierKind, backends: ClassifierBackends, threshold = FALLBACK_THRESHOLD): Classifier {
  switch (kind) {
    case "embedding":
      return new EmbeddingClassifier(backends.embed);
    case "model":
      return new ModelClassifier(backends.model);
    case "fallback":
      return new FallbackClassifier(new EmbeddingClassifier(backends.embed), new ModelClassifier(backends.model), threshold);
    default:
      return assertNever(kind);
  }
}

export type { Classification, ClassifiedBy, Classifier, Verdict } from "./types";

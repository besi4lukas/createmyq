/**
 * STM-22: the topic gate in the Workflow, as pure rules. generation.ts samples
 * the chunks (worker/chunk/sample.ts, the same sampler the STM-21 benchmark
 * used), calls classifierFor(env), and uses these to word the refusal, build
 * the decision written onto the bank source, and price the classifier's calls
 * for model_calls. No I/O here.
 */
import type { Sample, SamplePosition } from "../chunk/sample";
import { ACTIVE_CLASSIFIER, FALLBACK_THRESHOLD, type Classification, type ClassifiedBy, type Verdict } from "../classifier";
import { CLASSIFIER_MODEL } from "../classifier/model";
import type { ClassifierUsage, SampleScore } from "../classifier/types";
import { EMBEDDING_MODEL } from "./embed";

/** Used when a refusal names no topic (the model may answer with an empty phrase). */
export const UNNAMED_TOPIC = "a different subject";

/** CLAUDE.md "User-facing messages": the off-topic refusal, stored in sources.error. */
export function offTopicMessage(detected: string | null): string {
  const topic = detected?.trim() || UNNAMED_TOPIC;
  return `This looks like ${topic}. CreateMyQ only covers software engineering right now.`;
}

/**
 * What `sources.classification_inputs` holds: which chunks were read and what
 * each scored, not their text. The text is not needed to audit a decision:
 * extraction and chunking are deterministic (the fingerprint is versioned), so
 * the bank's R2 object plus these ordinals and character ranges give back the
 * exact excerpts. Storing them would put ~12 KB of an upload's text in a
 * second place for every source, refused ones included.
 */
export type ClassificationInputs = {
  version: 1;
  /** The setup that decided (worker/classifier/index.ts), so a later swap is visible in old rows. */
  classifier: typeof ACTIVE_CLASSIFIER;
  threshold: number;
  samples: {
    position: SamplePosition;
    ordinal: number;
    charStart: number;
    charEnd: number;
    location: string | null;
    headingPath: string[];
    /** Embedding scores for this sample, when embeddings were computed. */
    scores: SampleScore | null;
  }[];
  /** Mean of the per-sample margins (positive leans software engineering). */
  embeddingMargin: number | null;
  /** The fallback's first opinion, when it was not sure enough and the model was asked. */
  primary: { by: ClassifiedBy; verdict: Verdict; confidence: number; detected: string | null } | null;
  usage: ClassifierUsage;
  costUsd: number;
};

export function classificationInputs(samples: readonly Sample[], c: Classification): ClassificationInputs {
  // The classifier scores samples in the order it gets them; chunks are never empty, so none is skipped.
  const scores = c.embedding?.samples.length === samples.length ? c.embedding.samples : null;
  return {
    version: 1,
    classifier: ACTIVE_CLASSIFIER,
    threshold: FALLBACK_THRESHOLD,
    samples: samples.map((s, i) => ({
      position: s.position,
      ordinal: s.chunk.ordinal,
      charStart: s.chunk.start,
      charEnd: s.chunk.end,
      location: s.chunk.location,
      headingPath: s.chunk.headingPath,
      scores: scores?.[i] ?? null,
    })),
    embeddingMargin: c.embedding?.margin ?? null,
    primary: c.primary ? { by: c.primary.by, verdict: c.primary.verdict, confidence: c.primary.confidence, detected: c.primary.detected } : null,
    usage: c.usage,
    costUsd: c.costUsd,
  };
}

/** One line for `sources.reason`: who decided, how sure, and why the model was asked. */
export function gateReason(c: Classification): string {
  const said = `${c.verdict}${c.detected ? ` as ${c.detected}` : ""} at ${c.confidence.toFixed(2)}`;
  const margin = c.embedding ? ` (embedding margin ${c.embedding.margin.toFixed(3)})` : "";
  if (c.by === "model" && c.primary) {
    return `model ${said}; embeddings were unsure (${c.primary.verdict} at ${c.primary.confidence.toFixed(2)} < ${FALLBACK_THRESHOLD})${margin}`;
  }
  return `${c.by} ${said}${margin}`;
}

/** The columns written onto the bank source. A refusal also ends it, with the message. */
export function gateDecision(samples: readonly Sample[], c: Classification) {
  return {
    gateVerdict: c.verdict,
    detectedNiche: c.detected,
    confidence: c.confidence,
    classifiedBy: c.by,
    reason: gateReason(c),
    classificationInputs: classificationInputs(samples, c),
    refusal: c.verdict === "refused" ? offTopicMessage(c.detected) : null,
  };
}

export type ClassifySpend = {
  /** Unique within the run; stableUuid(instanceId, label) is the model_calls id. */
  label: string;
  purpose: "classify";
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/**
 * model_calls rows for one classification: one per backend that was called
 * (embeddings, and Haiku when the fallback asked it). A fallback's totals
 * include its primary, so the second row is the total minus the primary.
 */
export function classifySpend(c: Classification): ClassifySpend[] {
  type Part = { by: ClassifiedBy; usage: ClassifierUsage; costUsd: number };
  const parts: Part[] = c.primary
    ? [
        c.primary,
        {
          by: c.by,
          usage: {
            inputTokens: c.usage.inputTokens - c.primary.usage.inputTokens,
            outputTokens: c.usage.outputTokens - c.primary.usage.outputTokens,
            embeddedChars: c.usage.embeddedChars - c.primary.usage.embeddedChars,
          },
          costUsd: c.costUsd - c.primary.costUsd,
        },
      ]
    : [c];
  return parts.map((p, i) => ({
    label: `classify:${i}:${p.by}`,
    purpose: "classify",
    ...(p.by === "embedding"
      ? { provider: "workers-ai", model: EMBEDDING_MODEL, inputTokens: 0, outputTokens: 0 }
      : { provider: "anthropic", model: CLASSIFIER_MODEL, inputTokens: p.usage.inputTokens, outputTokens: p.usage.outputTokens }),
    costUsd: Math.max(0, p.costUsd),
  }));
}

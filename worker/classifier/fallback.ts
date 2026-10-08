/**
 * STM-21: ask the cheap classifier first; when it is less sure than
 * `threshold`, ask the other one and use its answer. The result's usage and
 * cost are the sum of both calls, and `primary` keeps what the first said.
 *
 * If the fallback fails it throws (the Workflow step retries); a low-confidence
 * guess is not used as a verdict.
 */
import { addUsage, type Classification, type Classifier } from "./types";

export class FallbackClassifier implements Classifier {
  constructor(
    private readonly primary: Classifier,
    private readonly fallback: Classifier,
    /** Fall through when the primary's confidence is below this (0.5–1). */
    readonly threshold: number,
  ) {}

  async classify(samples: readonly string[]): Promise<Classification> {
    const first = await this.primary.classify(samples);
    if (first.confidence >= this.threshold) return first;
    const second = await this.fallback.classify(samples);
    const { primary: _ignored, ...firstFlat } = first;
    void _ignored;
    return {
      ...second,
      embedding: second.embedding ?? first.embedding,
      usage: addUsage(first.usage, second.usage),
      costUsd: first.costUsd + second.costUsd,
      primary: firstFlat,
    };
  }
}

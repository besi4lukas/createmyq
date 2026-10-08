/**
 * Test-only fakes for the STM-21 classifier backends. Never bundled.
 *
 * fakeEmbedder: label descriptions (documents) become one-hot vectors, one
 * dimension per label in ACCEPT_LABELS ++ REFUSE_LABELS order. A sample
 * (query) is embedded by the `toVector` function the test gives, so a test
 * can say exactly how close each sample is to each label.
 */
import type { Embedder } from "../classifier/embedding";
import { ACCEPT_LABELS, REFUSE_LABELS } from "../classifier/labels";
import type { ModelCall, ModelReply } from "../workflows/generate";

export const LABEL_IDS = [...ACCEPT_LABELS, ...REFUSE_LABELS].map((l) => l.id);
export const DIMS = LABEL_IDS.length;

/** A vector with these weights on the named labels' dimensions. */
export function towards(weights: Record<string, number>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [id, w] of Object.entries(weights)) {
    const i = LABEL_IDS.indexOf(id);
    if (i < 0) throw new Error(`no label ${id}`);
    v[i] = w;
  }
  return v;
}

export type EmbedCall = { kind: "queries" | "documents"; texts: string[]; instruction?: string };

export function fakeEmbedder(toVector: (sample: string) => number[], calls: EmbedCall[] = []): Embedder {
  return async (input) => {
    if ("queries" in input) {
      calls.push({ kind: "queries", texts: input.queries, instruction: input.instruction });
      return { vectors: input.queries.map(toVector), costUsd: 0.00001 };
    }
    calls.push({ kind: "documents", texts: input.documents });
    return { vectors: input.documents.map((_, i) => towards({ [LABEL_IDS[i]!]: 1 })), costUsd: 0.00002 };
  };
}

export function fakeModel(reply: Partial<ModelReply> & { json?: unknown }, calls: { system: string; user: string }[] = []): ModelCall {
  return async (request) => {
    calls.push(request);
    return {
      text: reply.text ?? JSON.stringify(reply.json),
      stopReason: reply.stopReason === undefined ? "end_turn" : reply.stopReason,
      usage: reply.usage ?? { inputTokens: 4000, outputTokens: 20 },
    };
  };
}

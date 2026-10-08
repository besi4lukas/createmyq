/**
 * The topic gate's input (STM-20 benchmark, STM-22 Workflow): the first,
 * middle and last chunk of a source. One function for both, so the accuracy
 * measured on the evaluation set is the accuracy of the gate in the Workflow.
 */
import type { Chunk } from "./index";

export type SamplePosition = "start" | "middle" | "end";
export type Sample = { position: SamplePosition; chunk: Chunk; text: string };

/** The first, middle and last chunk (fewer when the source has fewer chunks). */
export function sampleChunks(text: string, chunks: readonly Chunk[]): Sample[] {
  if (chunks.length === 0) return [];
  const picks: [SamplePosition, number][] = [
    ["start", 0],
    ["middle", Math.floor((chunks.length - 1) / 2)],
    ["end", chunks.length - 1],
  ];
  const used = new Set<number>();
  const samples: Sample[] = [];
  for (const [position, i] of picks) {
    if (used.has(i)) continue;
    used.add(i);
    const chunk = chunks[i]!;
    samples.push({ position, chunk, text: text.slice(chunk.start, chunk.end) });
  }
  return samples;
}

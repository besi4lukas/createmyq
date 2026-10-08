/**
 * STM-18: write a finished bank. One transaction: the bank moves to `ready`,
 * the chunks its questions cite go into source_chunks, and the questions go
 * into questions. Called only by the lock holder, after renewing the lock
 * (generation.ts).
 *
 * Re-runnable: the first statement only matches a bank still `processing`. If
 * an earlier attempt committed, the bank is `ready`, nothing matches and
 * nothing is written twice.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Chunk } from "../chunk";
import type { Db } from "../db/client";
import { questions, sourceChunks, sources } from "../db/schema";
import type { Tag } from "../classifier/tag";
import type { KeptQuestion } from "./filter";
import { allowedFrom } from "./rules";

/**
 * A kept question with the classifier's tags (STM-23, worker/classifier/tag.ts).
 * Format and difficulty come only from here, never from the generator.
 */
export type TaggedQuestion = KeptQuestion & Tag;

export async function storeBank(
  db: Db,
  bankSourceId: string,
  text: string,
  chunks: Chunk[],
  generated: TaggedQuestion[],
): Promise<{ stored: boolean }> {
  return db.transaction(async (tx) => {
    const [ready] = await tx
      .update(sources)
      .set({ status: "ready", error: null, updatedAt: sql`now()` })
      .where(and(eq(sources.id, bankSourceId), inArray(sources.status, allowedFrom("ready"))))
      .returning({ id: sources.id });
    if (!ready) return { stored: false };

    const cited = chunks.filter((c) => generated.some((q) => q.chunkOrdinal === c.ordinal));
    const chunkRows = await tx
      .insert(sourceChunks)
      .values(
        cited.map((c) => ({
          sourceId: bankSourceId,
          ordinal: c.ordinal,
          text: text.slice(c.start, c.end),
          headingPath: c.headingPath,
          charStart: c.start,
          charEnd: c.end,
        })),
      )
      .returning({ id: sourceChunks.id, ordinal: sourceChunks.ordinal });

    await tx.insert(questions).values(
      generated.map((q) => {
        const chunk = cited.find((c) => c.ordinal === q.chunkOrdinal)!;
        return {
          sourceId: bankSourceId,
          chunkId: chunkRows.find((r) => r.ordinal === q.chunkOrdinal)!.id,
          origin: "generated" as const,
          format: q.format,
          difficulty: q.difficulty,
          topic: q.topic,
          prompt: q.prompt,
          explanation: q.explanation,
          payload: { options: q.options, answer: q.answer },
          // charStart/charEnd are the chunk's range in the extracted text; the quote is inside it.
          citation: { headingPath: chunk.headingPath, location: chunk.location, charStart: chunk.start, charEnd: chunk.end, quote: q.quote },
          // STM-19: the rubric score (null if the grader failed) and the vector the near-duplicate filter used.
          qualityScore: q.qualityScore,
          embedding: q.embedding,
        };
      }),
    );
    return { stored: true };
  });
}

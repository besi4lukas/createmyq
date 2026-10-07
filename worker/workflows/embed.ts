/**
 * STM-19: question embeddings for the near-duplicate filter, from Workers AI
 * (the AI binding, wrangler.jsonc). Anthropic has no embeddings API.
 *
 * Qwen3-Embedding-0.6B: 1024 dimensions, $0.0118 per million input tokens (a
 * run embeds ~25 short texts, ~2k tokens: well under $0.001). It takes a task
 * instruction; with the one below it separated reworded questions from
 * different ones on the same topic better than bge-small/base/large,
 * embeddinggemma-300m, or Qwen3 without it (filter.ts: NEAR_DUPLICATE).
 * Vectors are stored in questions.embedding (pgvector, no fixed dimension).
 */
export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_INSTRUCTION = "Given a quiz question and its answer, retrieve quiz questions that test the same fact";
/** Estimate for the cost log only: Workers AI returns no token count. */
const USD_PER_CHAR = 0.0118 / 1_000_000 / 4;

/**
 * One vector per text, in order. Throws if the reply is not that (the step
 * retries). Values are rounded to 6 decimals: the step result stays small
 * (25 × 1024 numbers ≈ 250 KB) and cosine similarity moves by < 1e-5.
 */
export async function embedTexts(ai: Ai, texts: string[]): Promise<{ vectors: number[][]; costUsd: number }> {
  if (texts.length === 0) return { vectors: [], costUsd: 0 };
  const out = await ai.run(EMBEDDING_MODEL, { queries: texts, instruction: EMBEDDING_INSTRUCTION });
  const data = out.data;
  if (!data || data.length !== texts.length || data.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error(`embedding reply has the wrong shape: ${JSON.stringify(out.shape ?? null)}`);
  }
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return { vectors: data.map((v) => v.map((x) => Math.round(x * 1e6) / 1e6)), costUsd: chars * USD_PER_CHAR };
}

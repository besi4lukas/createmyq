/**
 * Quiz assembly (STM-8): pick `length` approved questions for a category and
 * difficulty from the shared bank. One plain SQL query, no model calls.
 *
 * Nothing is written here. The quiz only becomes a `sessions` row when it is
 * finished and flushed from the user's Durable Object (STM-9, STM-10).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { questionDifficultySchema, multipleChoicePayload } from "../questions/payload";

/** A question is "seen" if it was in one of the user's sessions finished this recently. */
export const SEEN_WINDOW_DAYS = 30;

/** Query string for `GET /api/quiz`. Lengths come from FR-5. */
export const assembleQuery = z.object({
  category: z.string().regex(/^[a-z0-9-]{1,64}$/),
  difficulty: questionDifficultySchema,
  length: z.enum(["5", "10", "20"]).transform(Number),
});
export type AssembleParams = z.infer<typeof assembleQuery> & { categoryId: string };

/** Full question row. Stays on the server: it carries the answer and explanation. */
export type AssembledQuestion = {
  id: string;
  format: "multiple_choice";
  difficulty: string;
  topic: string | null;
  prompt: string;
  explanation: string;
  payload: z.infer<typeof multipleChoicePayload>;
};

/**
 * Sampling and the fallback when the pool runs dry (FR-6), all in the ORDER BY:
 *
 * 1. Questions the user hasn't seen in the last 30 days come first, in random
 *    order (`seen_at` is null for them; ORDER BY random() is fine for a pool
 *    of hundreds of rows).
 * 2. If fewer than `length` are unseen, the rest is filled with the ones seen
 *    longest ago (oldest `seen_at` first; random among ties).
 * 3. If the whole pool is smaller than `length`, every question in it is
 *    returned and the caller gets fewer than it asked for (the route flags it).
 *
 * "Seen" means it was in a *finished* session: only finished quizzes reach
 * Postgres. An unfinished quiz lives in the user's DO and is resumed, not
 * re-assembled (FR-18).
 *
 * The pool is approved multiple-choice questions (the only format the quiz UI
 * takes) in the category and difficulty. A question from a source is served
 * only if that source is shared to the group or this user uploaded the same
 * file (FR-10a). Seeded questions have no source and are always served.
 */
export async function assembleQuiz(
  db: Db,
  userId: string,
  { categoryId, difficulty, length }: AssembleParams,
): Promise<AssembledQuestion[]> {
  const { rows } = await db.execute<Omit<AssembledQuestion, "payload"> & { payload: unknown }>(sql`
    with seen as (
      select sq.question_id, max(s.finished_at) as seen_at
      from sessions s
      join session_questions sq on sq.session_id = s.id
      where s.user_id = ${userId}
        and s.finished_at > now() - make_interval(days => ${SEEN_WINDOW_DAYS})
      group by sq.question_id
    )
    select q.id, q.format, q.difficulty, q.topic, q.prompt, q.explanation, q.payload
    from questions q
    left join seen on seen.question_id = q.id
    where q.status = 'approved'
      and q.category_id = ${categoryId}
      and q.difficulty = ${difficulty}
      and q.format = 'multiple_choice'
      and (
        q.source_id is null
        or exists (
          select 1 from sources src
          where src.id = q.source_id
            and (
              src.visibility = 'group'
              or exists (
                select 1 from source_uploads up
                where up.source_id = src.id and up.user_id = ${userId}
              )
            )
        )
      )
    order by seen.seen_at asc nulls first, random()
    limit ${length}
  `);
  // The payload is jsonb; re-check its shape so a bad row fails loudly here
  // rather than showing a broken question.
  return rows.map((row) => ({ ...row, payload: multipleChoicePayload.parse(row.payload) }));
}

/**
 * What the browser gets: no answer, no explanation (grading comes later).
 * Options keep their authored order; the seed bank already spreads the
 * correct answer evenly across positions.
 */
export function toPublicQuestion(q: AssembledQuestion) {
  return {
    id: q.id,
    format: q.format,
    difficulty: q.difficulty,
    topic: q.topic,
    prompt: q.prompt,
    options: q.payload.options,
  };
}

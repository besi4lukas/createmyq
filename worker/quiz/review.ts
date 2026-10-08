/**
 * STM-25: the review quiz. Built from this user's unresolved misses only, with
 * one plain query and no model calls, like STM-8 assembly.
 *
 * Differences from a category quiz (worker/quiz/assemble.ts):
 *  - no 30-day "seen" exclusion: a recent miss is exactly what to review;
 *  - any category and difficulty: the session has kind "review" and null
 *    category and difficulty;
 *  - oldest miss first (random among ties), so with more misses than the
 *    length the longest-waiting ones come up first. Missing one again moves it
 *    to the back (missed_at is the latest miss).
 * Same as a category quiz: only approved multiple-choice questions, and the
 * private-source rule (`visibleTo`). A hidden or retired question keeps its
 * miss row but is not served.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { multipleChoicePayload } from "../questions/payload";
import { visibleTo, type AssembledQuestion } from "./assemble";

/** The servable unresolved misses of `userId`, as a FROM … WHERE (alias q for questions, m for misses). */
const reviewPool = (userId: string): SQL => sql`
  from misses m
  join questions q on q.id = m.question_id
  where m.user_id = ${userId}
    and m.resolved_at is null
    and q.status = 'approved'
    and q.format = 'multiple_choice'
    and ${visibleTo(userId)}
`;

/** Up to `length` questions to review, oldest miss first. Empty when there is nothing to review. */
export async function assembleReview(db: Db, userId: string, length: number): Promise<AssembledQuestion[]> {
  const { rows } = await db.execute<Omit<AssembledQuestion, "payload"> & { payload: unknown }>(sql`
    select q.id, q.format, q.difficulty, q.topic, q.prompt, q.explanation, q.payload
    ${reviewPool(userId)}
    order by m.missed_at asc, random()
    limit ${length}
  `);
  return rows.map((row) => ({ ...row, payload: multipleChoicePayload.parse(row.payload) }));
}

/** How many questions are waiting for review (what Home and Results show). */
export async function countReview(db: Db, userId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number | string }>(sql`select count(*)::int as n ${reviewPool(userId)}`);
  return Number(rows[0]?.n ?? 0);
}

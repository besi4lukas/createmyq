/**
 * A quiz on one of the user's own sources (Home's inline upload card and
 * saved-source rows). One plain query over the bank, no model calls, like
 * STM-8 assembly (worker/quiz/assemble.ts), whose sampling it shares:
 *  - the user's own source is looked up first (own-source.ts: only through
 *    their `source_uploads` row), and a duplicate resolves to its bank
 *    (STM-16: the uploader of a duplicate gets the bank's questions);
 *  - the pool is that bank's approved multiple-choice questions at the chosen
 *    difficulty, with the private-source rule (`visibleTo`) on top;
 *  - unseen first at random, then the least recently seen (`seenBy`);
 *  - a pool smaller than `length` is returned whole (the client sees
 *    questionCount < length, as with a short category pool). STM-23 assigns
 *    difficulty per question, so a source may have none at some level: that
 *    is a 404 naming the level, never a quiz from another level.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { multipleChoicePayload } from "../questions/payload";
import { findOwnSource } from "../sources/own-source";
import { seenBy, visibleTo, type AssembledQuestion } from "./assemble";

export type SourcePickParams = { sourceId: string; difficulty: string; length: number };

export type SourcePicked =
  | { ok: true; bankSourceId: string; title: string; questions: AssembledQuestion[] }
  | { ok: false; status: 404 | 409; code: "source_not_found" | "source_not_ready" | "no_questions"; error: string };

/** Up to `length` questions from bank `bankSourceId` at `difficulty`, for `userId`. */
export async function assembleSourceQuiz(
  db: Db,
  userId: string,
  { bankSourceId, difficulty, length }: { bankSourceId: string; difficulty: string; length: number },
): Promise<AssembledQuestion[]> {
  const { rows } = await db.execute<Omit<AssembledQuestion, "payload"> & { payload: unknown }>(sql`
    with ${seenBy(userId)}
    select q.id, q.format, q.difficulty, q.topic, q.prompt, q.explanation, q.payload
    from questions q
    left join seen on seen.question_id = q.id
    where q.status = 'approved'
      and q.source_id = ${bankSourceId}
      and q.difficulty = ${difficulty}
      and q.format = 'multiple_choice'
      and ${visibleTo(userId)}
    order by seen.seen_at asc nulls first, random()
    limit ${length}
  `);
  return rows.map((row) => ({ ...row, payload: multipleChoicePayload.parse(row.payload) }));
}

/** The source lookup + assembly POST /api/session needs for `{ kind: "source" }`. */
export async function pickSourceQuestions(db: Db, userId: string, p: SourcePickParams): Promise<SourcePicked> {
  const source = await findOwnSource(db, userId, p.sourceId);
  if (!source) return { ok: false, status: 404, code: "source_not_found", error: "We could not find that source." };
  if (source.status !== "ready") {
    return { ok: false, status: 409, code: "source_not_ready", error: "This source has no quiz yet. It may still be working." };
  }
  const questions = await assembleSourceQuiz(db, userId, {
    bankSourceId: source.bankSourceId,
    difficulty: p.difficulty,
    length: p.length,
  });
  if (questions.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "no_questions",
      error: `This source has no ${p.difficulty} questions. Try another difficulty.`,
    };
  }
  return { ok: true, bankSourceId: source.bankSourceId, title: source.title ?? source.url ?? "Your source", questions };
}

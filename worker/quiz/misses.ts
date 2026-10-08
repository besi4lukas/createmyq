/**
 * STM-25: misses. A miss is a question this user got wrong (or left
 * unanswered) and has not yet got right twice in a row since.
 *
 * `misses` is materialised state, but it is never *incremented*: every write
 * recomputes a question's row from the user's whole history of that question
 * in Postgres (`session_questions` + `answers`, oldest first) and overwrites
 * it. That makes the write idempotent and order-independent: running it twice,
 * or for sessions flushed out of order (an alarm retry landing after a newer
 * quiz), always gives the same row, so a streak can never be double-counted
 * and a resolved miss is never re-opened by a replay.
 *
 * It runs inside the STM-10 flush transaction (worker/quiz/flush.ts), only for
 * the questions of the session just inserted, behind a savepoint so a failure
 * here can never stop the session itself from being saved.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

/** Correct answers in a row that clear a miss. */
export const RESOLVE_AFTER = 2;

/**
 * One appearance of a question in a finished session. `verdict` null means it
 * was served but not answered (finished early): that counts as a miss, as it
 * does in the score. `partial` (short answers, later) is not correct either.
 */
export type Outcome = { at: Date; verdict: "correct" | "partial" | "incorrect" | null };

export type MissState = { missedAt: Date; resolvedAt: Date | null; correctStreak: number };

/**
 * The miss row after `history` (oldest first), or null if the question was
 * never missed. Rules:
 *  - not correct (incorrect, partial, unanswered) → open: missedAt = then,
 *    streak 0, resolvedAt null. This also re-opens a resolved miss.
 *  - correct while open → streak + 1; at RESOLVE_AFTER it resolves (resolvedAt = then).
 *  - correct while resolved, or before any miss → no change.
 * Any quiz counts (category or review): it is just the question's history.
 */
export function foldMiss(history: readonly Outcome[]): MissState | null {
  let state: MissState | null = null;
  for (const { at, verdict } of history) {
    if (verdict !== "correct") {
      state = { missedAt: at, resolvedAt: null, correctStreak: 0 };
    } else if (state && state.resolvedAt === null) {
      const correctStreak: number = state.correctStreak + 1;
      state = { missedAt: state.missedAt, correctStreak, resolvedAt: correctStreak >= RESOLVE_AFTER ? at : null };
    }
  }
  return state;
}

/** Group history rows (already ordered oldest first) by question. */
export function groupHistory(
  rows: readonly { question_id: string; at: Date | string; verdict: Outcome["verdict"] }[],
): Map<string, Outcome[]> {
  const byQuestion = new Map<string, Outcome[]>();
  for (const r of rows) {
    const list = byQuestion.get(r.question_id) ?? [];
    list.push({ at: new Date(r.at), verdict: r.verdict });
    byQuestion.set(r.question_id, list);
  }
  return byQuestion;
}

/**
 * Recompute and store the miss rows of `questionIds` for `userId` from their
 * full history. Call it inside a transaction (the flush's).
 *
 * The advisory lock (per user, held to the end of the transaction) serialises
 * two flushes of the same user: the second one waits, then its history query
 * (a new snapshot under READ COMMITTED) sees the first one's session. Without
 * it, two concurrent flushes could each miss the other's answer.
 */
export async function refreshMisses(tx: Pick<Db, "execute">, userId: string, questionIds: readonly string[]) {
  if (questionIds.length === 0) return 0;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`misses:${userId}`}, 0))`);

  const ids = sql.join(
    questionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // Every time this user was served one of these questions, oldest first.
  // A session_questions row with no answers row = served, not answered.
  const { rows } = await tx.execute<{ question_id: string; at: Date | string; verdict: Outcome["verdict"] }>(sql`
    select sq.question_id, coalesce(a.answered_at, s.finished_at) as at, a.verdict
    from sessions s
    join session_questions sq on sq.session_id = s.id
    left join answers a on a.session_id = sq.session_id and a.ordinal = sq.ordinal
    where s.user_id = ${userId}
      and sq.question_id in (${ids})
    order by s.finished_at, s.started_at, sq.ordinal
  `);

  let written = 0;
  for (const [questionId, history] of groupHistory(rows)) {
    const m = foldMiss(history);
    if (!m) continue; // never missed: no row
    await tx.execute(sql`
      insert into misses (user_id, question_id, missed_at, resolved_at, correct_streak)
      values (${userId}, ${questionId}, ${m.missedAt.toISOString()}, ${m.resolvedAt?.toISOString() ?? null}, ${m.correctStreak})
      on conflict (user_id, question_id) do update
        set missed_at = excluded.missed_at,
            resolved_at = excluded.resolved_at,
            correct_streak = excluded.correct_streak
    `);
    written++;
  }
  return written;
}

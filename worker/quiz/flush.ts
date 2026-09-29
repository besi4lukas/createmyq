/**
 * STM-10: write one finished quiz to Postgres, as the permanent record.
 *
 * Called only by the UserSession Durable Object (worker/durable/user-session.ts),
 * which owns the retry loop and deletes its copy only after this resolves.
 *
 * Everything happens in ONE transaction: the `sessions` row, one
 * `session_questions` row per question served, and one `answers` row per
 * question answered. Either all of it commits or none of it does.
 *
 * Idempotent by `sessions.idempotency_key` (UNIQUE): the insert is
 * ON CONFLICT DO NOTHING, and a conflict means an earlier attempt already
 * committed the whole session (children included, same transaction), so this
 * returns without writing anything. That is what makes every crash and retry
 * converge to exactly one row, including "committed, but the DO died before it
 * could delete its copy".
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { answers, sessionQuestions, sessions } from "../db/schema";
import type { FinishedQuiz } from "../durable/user-session";
import { questionDifficultySchema } from "../questions/payload";

/** `true` if this call inserted the session, `false` if it was already there. */
export async function writeFinishedSession(db: Db, userId: string, quiz: FinishedQuiz): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(sessions)
      .values({
        userId,
        idempotencyKey: quiz.idempotencyKey,
        kind: quiz.kind,
        // A subselect, not the raw id: if the category were ever deleted the
        // FK would reject the insert on every retry forever. It is nullable.
        categoryId: sql`(select id from categories where id = ${quiz.categoryId})`,
        mode: quiz.mode,
        // Validated by the route at start; typed as a plain string on the quiz.
        difficulty: questionDifficultySchema.parse(quiz.difficulty),
        questionCount: quiz.questions.length,
        score: quiz.score,
        startedAt: new Date(quiz.startedAt),
        finishedAt: new Date(quiz.finishedAt),
      })
      .onConflictDoNothing({ target: sessions.idempotencyKey })
      .returning({ id: sessions.id });
    // Already stored by an earlier attempt. Its children were written in that
    // same transaction, so there is nothing left to do.
    if (!inserted) return false;

    await tx.insert(sessionQuestions).values(
      quiz.questions.map((q, ordinal) => ({
        sessionId: inserted.id,
        ordinal,
        // Same reason as categoryId: a question deleted since it was served
        // leaves question_id null (the snapshot is what matters) instead of
        // turning this quiz into one that can never be written.
        questionId: sql`(select id from questions where id = ${q.id})`,
        // Exactly what the user saw, answer and explanation included.
        questionSnapshot: q,
      })),
    );

    // Unanswered questions (finished early) get no answers row: the verdict
    // enum has no "unanswered" and raw_answer is NOT NULL, so a session_questions
    // row without an answers row IS the record of "not answered". They already
    // count as not correct in the score.
    if (quiz.answers.length > 0) {
      await tx.insert(answers).values(
        quiz.answers.map((a, ordinal) => ({
          sessionId: inserted.id,
          ordinal,
          rawAnswer: { option: a.option, choice: a.choice },
          verdict: a.correct ? ("correct" as const) : ("incorrect" as const),
          gradedBy: "code" as const, // multiple choice is graded in code (FR-15)
          answeredAt: new Date(a.answeredAt),
        })),
      );
    }
    return true;
  });
}

import { describe, expect, it } from "vitest";
import type { AssembledQuestion } from "./assemble";
import { answerQuiz, grade, newQuiz, scoreQuiz, toPublicQuiz, toResult } from "./session-state";

const q = (n: number, answer: string): AssembledQuestion => ({
  id: `q${n}`,
  format: "multiple_choice",
  difficulty: "intermediate",
  topic: null,
  prompt: `p${n}`,
  explanation: `e${n}`,
  payload: { options: ["w", "x", "y", "z"], answer },
});
const T0 = "2026-09-30T10:00:00.000Z";
const T1 = "2026-09-30T10:01:00.000Z";
const quizOf = (mode: "practice" | "exam") =>
  newQuiz(
    { kind: "category", userId: "u", categoryId: "c", category: "system-design", sourceId: null, sourceTitle: null, difficulty: "intermediate", mode, length: 10, questions: [q(1, "x"), q(2, "z")] },
    { quizId: "quiz-1", idempotencyKey: "key-1" },
    T0,
  );

describe("grade", () => {
  it("compares the chosen option's text with the answer", () => {
    expect(grade(q(1, "x"), 1)).toEqual({ choice: "x", correct: true });
    expect(grade(q(1, "x"), 0)).toEqual({ choice: "w", correct: false });
    expect(grade(q(1, "x"), 4)).toBeNull();
  });
});

describe("answerQuiz / scoreQuiz", () => {
  it("appends only a new, in-order answer and stamps the time", () => {
    const quiz = quizOf("practice");
    const out = answerQuiz(quiz, "quiz-1", 0, 1, T1);
    expect(out).toMatchObject({ ok: true, duplicate: false, currentIndex: 1, done: false });
    expect(quiz.answers).toEqual([{ option: 1, choice: "x", correct: true, answeredAt: T1 }]);
    expect(answerQuiz(quiz, "quiz-1", 0, 2, T1)).toMatchObject({ ok: true, duplicate: true, answer: { option: 1 } });
    expect(quiz.answers).toHaveLength(1);
    expect(answerQuiz(quiz, "quiz-1", 1, 9, T1)).toEqual({ ok: false, code: "bad_option", currentIndex: 1 });
    expect(quiz.answers).toHaveLength(1);
    expect(answerQuiz(undefined, "quiz-1", 0, 0, T1)).toEqual({ ok: false, code: "no_quiz" });
  });

  it("scores correct answers only; unanswered count as wrong", () => {
    const quiz = quizOf("exam");
    answerQuiz(quiz, "quiz-1", 0, 1, T1);
    const done = scoreQuiz(quiz, T1);
    expect(done).toMatchObject({ finishedAt: T1, score: 1 });
    const result = toResult(done);
    expect(result.review.map((r) => [r.correct, r.choice])).toEqual([
      [true, "x"],
      [false, null],
    ]);
  });
});

describe("toPublicQuiz", () => {
  it("never includes the answer key, the idempotency key or the user", () => {
    const quiz = quizOf("practice");
    const wire = JSON.stringify(toPublicQuiz(quiz));
    for (const secret of ['"answer"', "e1", "key-1", '"userId"', "categoryId"]) expect(wire).not.toContain(secret);
    expect(toPublicQuiz(quiz).questions[0]).toEqual({
      index: 0,
      id: "q1",
      format: "multiple_choice",
      difficulty: "intermediate",
      topic: null,
      prompt: "p1",
      options: ["w", "x", "y", "z"],
    });
  });
});

/**
 * The quiz in progress as data, and the pure rules over it (STM-9): start,
 * grade, answer in order, finish, and what the client may see at each point.
 * No storage and no clock here: the UserSession object reads and writes KV and
 * passes in the time and ids, so these are plain synchronous functions.
 */
import { assertNever } from "../lib/assert";
import { toPublicQuestion, type AssembledQuestion } from "./assemble";
import type { QuizMode } from "./schemas";

export type StoredAnswer = {
  /** Index into `options` the user picked. */
  option: number;
  /** The option text at that index, as the user saw it (raw_answer for STM-10). */
  choice: string;
  correct: boolean;
  answeredAt: string;
};

/** Everything STM-10 needs to write sessions, session_questions and answers. */
export type Quiz = {
  /** Public id the client names the quiz by (answer, finish). */
  quizId: string;
  /**
   * users.id of the owner (sessions.user_id). Added in STM-10; quizzes started
   * before that don't have it and fall back to the object's name, which is the
   * same users.id (`idFromName(users.id)`).
   */
  userId?: string;
  /** Generated at start; sessions.idempotency_key. Server side only. */
  idempotencyKey: string;
  /**
   * "category": built from one category at one difficulty (STM-8).
   * "review": built from the user's unresolved misses (STM-25); it mixes
   * categories and difficulties, so those three fields are null.
   */
  kind: QuizKind;
  categoryId: string | null;
  category: string | null;
  difficulty: AssembledQuestion["difficulty"] | null;
  mode: QuizMode;
  /** What the user asked for; `questions.length` can be smaller (short pool). */
  length: number;
  startedAt: string;
  finishedAt: string | null;
  score: number | null;
  /** What the user actually saw, in order (session_questions.question_snapshot). */
  questions: AssembledQuestion[];
  /** answers[i] is the answer to questions[i]. Its length is the current index. */
  answers: StoredAnswer[];
};

export type QuizKind = "category" | "review";

export type StartInput = Pick<
  Quiz,
  "kind" | "userId" | "categoryId" | "category" | "difficulty" | "mode" | "length"
> & {
  questions: AssembledQuestion[];
};

/** A quiz under `quiz:done:*`: finished and scored. What the flush writes. */
export type FinishedQuiz = Quiz & { finishedAt: string; score: number };

export function newQuiz(input: StartInput, ids: { quizId: string; idempotencyKey: string }, now: string): Quiz {
  return {
    ...input,
    ...ids,
    startedAt: now,
    finishedAt: null,
    score: null,
    answers: [],
  };
}

/**
 * Grade option `option` of question `q`, or null if there is no such option.
 * One case per question format: a new format adds a case here (the compiler
 * insists), graded in code for multiple choice (FR-15).
 */
export function grade(q: AssembledQuestion, option: number): { choice: string; correct: boolean } | null {
  switch (q.format) {
    case "multiple_choice": {
      const choice = q.payload.options[option];
      return choice === undefined ? null : { choice, correct: choice === q.payload.answer };
    }
    default:
      return assertNever(q.format);
  }
}

// ---------------------------------------------------------------------------
// What leaves the object
// ---------------------------------------------------------------------------

/** Practice reveals the verdict and explanation after each question (FR-16). */
function feedback(q: AssembledQuestion, a: StoredAnswer) {
  return { correct: a.correct, correctAnswer: q.payload.answer, explanation: q.explanation };
}

/** A prior answer as the client may see it mid-quiz: Exam gets the choice only. */
function publicAnswer(quiz: Quiz, index: number) {
  const a = quiz.answers[index]!;
  const base = { index, option: a.option, choice: a.choice };
  return quiz.mode === "practice" ? { ...base, ...feedback(quiz.questions[index]!, a) } : base;
}

export function toPublicQuiz(quiz: Quiz) {
  return {
    quizId: quiz.quizId,
    kind: quiz.kind,
    category: quiz.category,
    difficulty: quiz.difficulty,
    mode: quiz.mode,
    length: quiz.length,
    questionCount: quiz.questions.length,
    startedAt: quiz.startedAt,
    currentIndex: quiz.answers.length,
    questions: quiz.questions.map((q, index) => ({ index, ...toPublicQuestion(q) })),
    answers: quiz.answers.map((_, i) => publicAnswer(quiz, i)),
  };
}
export type PublicQuiz = ReturnType<typeof toPublicQuiz>;

/** Finish: the score and every question with its answer, in both modes (FR-16, FR-19). */
export function toResult(quiz: Quiz) {
  return {
    quizId: quiz.quizId,
    kind: quiz.kind,
    category: quiz.category,
    difficulty: quiz.difficulty,
    mode: quiz.mode,
    startedAt: quiz.startedAt,
    finishedAt: quiz.finishedAt!,
    score: quiz.score!,
    questionCount: quiz.questions.length,
    answered: quiz.answers.length,
    review: quiz.questions.map((q, i) => {
      const a = quiz.answers[i];
      return {
        index: i,
        ...toPublicQuestion(q),
        option: a?.option ?? null,
        choice: a?.choice ?? null,
        // An unanswered question (finished early) counts as not correct.
        correct: a?.correct ?? false,
        correctAnswer: q.payload.answer,
        explanation: q.explanation,
      };
    }),
  };
}
export type QuizResult = ReturnType<typeof toResult>;

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type AnswerOutcome =
  | {
      ok: true;
      /** true when this index was already answered: nothing changed, the stored answer is returned. */
      duplicate: boolean;
      answer: ReturnType<typeof publicAnswer>;
      currentIndex: number;
      done: boolean;
    }
  | { ok: false; code: "no_quiz" | "not_current_quiz" | "out_of_order" | "bad_option"; currentIndex?: number };

/**
 * Answer question `index` of quiz `quizId` with `option`. On a new answer it is
 * appended to `quiz.answers` (the caller stores the quiz when the outcome is
 * `ok` and not `duplicate`); every other outcome leaves `quiz` untouched.
 *
 * An answer naming any quiz other than `quiz` is `not_current_quiz`. Answers
 * are strictly in order, so `index < currentIndex` means already answered: the
 * stored answer comes back with `duplicate: true`, even for a different option
 * (an answer is never changed once given). `index > currentIndex` is rejected.
 */
export function answerQuiz(
  quiz: Quiz | undefined,
  quizId: string,
  index: number,
  option: number,
  now: string,
): AnswerOutcome {
  if (!quiz) return { ok: false, code: "no_quiz" };
  if (quiz.quizId !== quizId) return { ok: false, code: "not_current_quiz" };

  const currentIndex = quiz.answers.length;
  const done = (n: number) => n >= quiz.questions.length;
  if (index < currentIndex) {
    return { ok: true, duplicate: true, answer: publicAnswer(quiz, index), currentIndex, done: done(currentIndex) };
  }
  if (index > currentIndex || done(currentIndex)) return { ok: false, code: "out_of_order", currentIndex };

  const graded = grade(quiz.questions[index]!, option);
  if (!graded) return { ok: false, code: "bad_option", currentIndex };

  quiz.answers.push({ option, ...graded, answeredAt: now });
  return { ok: true, duplicate: false, answer: publicAnswer(quiz, index), currentIndex: index + 1, done: done(index + 1) };
}

/** Stamp `quiz` finished and scored. Unanswered questions count as not correct. */
export function scoreQuiz(quiz: Quiz, now: string): FinishedQuiz {
  quiz.finishedAt = now;
  quiz.score = quiz.answers.filter((a) => a.correct).length;
  return quiz as FinishedQuiz;
}

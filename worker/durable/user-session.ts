/**
 * UserSession (STM-9): one Durable Object per user, addressed by
 * `idFromName(users.id)`. It is the boss while a quiz is running: the quiz in
 * progress, the answers so far and the user's preferences live here, and every
 * answer is written here first (CLAUDE.md "Where state lives").
 *
 * Storage is the SQLite-backed synchronous KV API (`ctx.storage.kv`). Every
 * method below is synchronous from start to end: no `await`, so no other
 * request can interleave with it. That is what makes start and answer safe to
 * double-submit (see `answer`).
 *
 * Keys:
 *   quiz:active          the quiz in progress (at most one)
 *   quiz:done:<quizId>   a finished quiz, kept until STM-10 has flushed it
 *   prefs                preferences
 *
 * Every quiz has a public `quizId` (random, opaque) that the client sends back
 * with each answer and with finish, so a late retry meant for an earlier quiz
 * can never land on the one in progress. The idempotency key is separate and
 * never leaves the object.
 *
 * The snapshot holds the full question (answer and explanation included). It
 * never leaves the object except through `toPublic*` / the finish review.
 */
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { sessionMode } from "../db/schema";
import { questionDifficultySchema, questionFormatSchema } from "../questions/payload";
import type { AssembledQuestion } from "../quiz/assemble";

// ---------------------------------------------------------------------------
// Preferences (FR-23). STM-24 adds the daily generation counter next to these.
// ---------------------------------------------------------------------------

export const quizModeSchema = z.enum(sessionMode.enumValues);
export const quizLengthSchema = z.union([z.literal(5), z.literal(10), z.literal(20)]);

export const prefsSchema = z.strictObject({
  defaultDifficulty: questionDifficultySchema,
  defaultMode: quizModeSchema,
  defaultLength: quizLengthSchema,
  formats: z
    .array(questionFormatSchema)
    .min(1)
    .refine((f) => new Set(f).size === f.length, "duplicate format"),
});
export type Prefs = z.infer<typeof prefsSchema>;
/** PUT /api/prefs: any subset of the fields, merged over the current prefs. */
export const prefsPatchSchema = prefsSchema.partial();

export const DEFAULT_PREFS: Prefs = {
  defaultDifficulty: "beginner",
  defaultMode: "practice",
  defaultLength: 10,
  formats: ["multiple_choice"],
};

// ---------------------------------------------------------------------------
// Quiz state
// ---------------------------------------------------------------------------

export type QuizMode = z.infer<typeof quizModeSchema>;

type StoredAnswer = {
  /** Index into `options` the user picked. */
  option: number;
  /** The option text at that index, as the user saw it (raw_answer for STM-10). */
  choice: string;
  correct: boolean;
  answeredAt: string;
};

/** Everything STM-10 needs to write sessions, session_questions and answers. */
type Quiz = {
  /** Public id the client names the quiz by (answer, finish). */
  quizId: string;
  /** Generated at start; sessions.idempotency_key. Server side only. */
  idempotencyKey: string;
  kind: "category";
  categoryId: string;
  category: string;
  difficulty: AssembledQuestion["difficulty"];
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

export type StartInput = Pick<Quiz, "categoryId" | "category" | "difficulty" | "mode" | "length"> & {
  questions: AssembledQuestion[];
};

const ACTIVE = "quiz:active";
const doneKey = (quizId: string) => `quiz:done:${quizId}`;
const PREFS = "prefs";

// ---------------------------------------------------------------------------
// What leaves the object
// ---------------------------------------------------------------------------

function publicQuestion(q: AssembledQuestion, index: number) {
  return {
    index,
    id: q.id,
    format: q.format,
    difficulty: q.difficulty,
    topic: q.topic,
    prompt: q.prompt,
    options: q.payload.options,
  };
}

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

function toPublicQuiz(quiz: Quiz) {
  return {
    quizId: quiz.quizId,
    category: quiz.category,
    difficulty: quiz.difficulty,
    mode: quiz.mode,
    length: quiz.length,
    questionCount: quiz.questions.length,
    startedAt: quiz.startedAt,
    currentIndex: quiz.answers.length,
    questions: quiz.questions.map(publicQuestion),
    answers: quiz.answers.map((_, i) => publicAnswer(quiz, i)),
  };
}
export type PublicQuiz = ReturnType<typeof toPublicQuiz>;

/** Finish: the score and every question with its answer, in both modes (FR-16, FR-19). */
function toResult(quiz: Quiz) {
  return {
    quizId: quiz.quizId,
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
        ...publicQuestion(q, i),
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

// ---------------------------------------------------------------------------
// The object
// ---------------------------------------------------------------------------

export class UserSession extends DurableObject<Env> {
  private get kv() {
    return this.ctx.storage.kv;
  }

  private active(): Quiz | undefined {
    return this.kv.get<Quiz>(ACTIVE);
  }

  /** The quiz in progress, without answer keys, or null. Resume is just this. */
  getActive(): PublicQuiz | null {
    const quiz = this.active();
    return quiz ? toPublicQuiz(quiz) : null;
  }

  /**
   * Start a quiz from questions the route assembled. If one is already in
   * progress it is left untouched and returned with `started: false`: an
   * interrupted quiz is resumed, never silently replaced (FR-18). The only
   * way out of a quiz is to finish it (early if need be), which keeps its answers.
   */
  start(input: StartInput): { started: boolean; quiz: PublicQuiz } {
    const existing = this.active();
    if (existing) return { started: false, quiz: toPublicQuiz(existing) };

    const quiz: Quiz = {
      ...input,
      quizId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      kind: "category",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      score: null,
      answers: [],
    };
    this.kv.put(ACTIVE, quiz);
    return { started: true, quiz: toPublicQuiz(quiz) };
  }

  /**
   * Answer question `index` of quiz `quizId` with option `option`, graded here
   * against the snapshot (multiple choice is graded in code, FR-15). An answer
   * naming any quiz other than the one in progress (e.g. a stale retry from a
   * finished quiz) is rejected with `not_current_quiz` and changes nothing.
   *
   * Idempotent by index: questions are answered strictly in order, so
   * `index < currentIndex` means it was already answered. A repeat (double
   * click, retried request) changes nothing and gets the stored answer back
   * with `duplicate: true`, even if it names a different option: an answer is
   * never changed or re-asked once given. `index > currentIndex` is rejected.
   */
  answer(quizId: string, index: number, option: number): AnswerOutcome {
    const quiz = this.active();
    if (!quiz) return { ok: false, code: "no_quiz" };
    if (quiz.quizId !== quizId) return { ok: false, code: "not_current_quiz" };

    const currentIndex = quiz.answers.length;
    const done = (n: number) => n >= quiz.questions.length;
    if (index < currentIndex) {
      return { ok: true, duplicate: true, answer: publicAnswer(quiz, index), currentIndex, done: done(currentIndex) };
    }
    if (index > currentIndex || done(currentIndex)) return { ok: false, code: "out_of_order", currentIndex };

    const q = quiz.questions[index]!;
    const choice = q.payload.options[option];
    if (choice === undefined) return { ok: false, code: "bad_option", currentIndex };

    quiz.answers.push({
      option,
      choice,
      correct: choice === q.payload.answer,
      answeredAt: new Date().toISOString(),
    });
    this.kv.put(ACTIVE, quiz);
    return { ok: true, duplicate: false, answer: publicAnswer(quiz, index), currentIndex: index + 1, done: done(index + 1) };
  }

  /**
   * Finish quiz `quizId`: score it and move it from `quiz:active` to
   * `quiz:done:<quizId>`, where it stays until Postgres confirms the flush
   * (STM-10). Nothing is deleted. A finished-but-unflushed quiz does not block
   * a new one: it no longer needs the user, only the flush.
   *
   * Finishing with unanswered questions is allowed (they count as not correct).
   * If `quizId` names an already-finished quiz, its stored result comes back
   * with `alreadyFinished: true` and the quiz in progress (if any) is not
   * touched, so a retried finish is harmless even after a new quiz started.
   */
  finish(quizId: string): { ok: true; alreadyFinished: boolean; result: QuizResult } | { ok: false; code: "no_quiz" } {
    const quiz = this.active();
    if (quiz?.quizId !== quizId) {
      const done = this.kv.get<Quiz>(doneKey(quizId));
      return done ? { ok: true, alreadyFinished: true, result: toResult(done) } : { ok: false, code: "no_quiz" };
    }

    quiz.finishedAt = new Date().toISOString();
    quiz.score = quiz.answers.filter((a) => a.correct).length;
    // Both writes happen in this one synchronous call, so they commit together.
    this.kv.put(doneKey(quiz.quizId), quiz);
    this.kv.delete(ACTIVE);
    // TODO(STM-10): flush quiz:done:* to Postgres in one transaction
    // (ON CONFLICT (idempotency_key) DO NOTHING), retry via alarm on failure,
    // and delete quiz:done:<key> only after the commit is confirmed.
    return { ok: true, alreadyFinished: false, result: toResult(quiz) };
  }

  getPrefs(): Prefs {
    const parsed = prefsSchema.safeParse(this.kv.get(PREFS));
    return parsed.success ? parsed.data : DEFAULT_PREFS;
  }

  /** Merge a validated patch over the current prefs. The route validates too; this is the last line. */
  setPrefs(patch: z.infer<typeof prefsPatchSchema>): Prefs {
    const next = prefsSchema.parse({ ...this.getPrefs(), ...prefsPatchSchema.parse(patch) });
    this.kv.put(PREFS, next);
    return next;
  }
}

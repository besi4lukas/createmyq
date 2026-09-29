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
 *   quiz:done:<quizId>   a finished quiz, kept until Postgres has confirmed it (STM-10)
 *   quiz:last            the most recently flushed quiz, so a retried finish still gets its result (STM-10)
 *   flush:retries        consecutive failed alarm passes, for the backoff (STM-10)
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
import { withDb } from "../db/client";
import { sessionMode } from "../db/schema";
import { questionDifficultySchema, questionFormatSchema } from "../questions/payload";
import type { AssembledQuestion } from "../quiz/assemble";
import { writeFinishedSession } from "../quiz/flush";

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
  /**
   * users.id of the owner (sessions.user_id). Added in STM-10; quizzes started
   * before that don't have it and fall back to the object's name, which is the
   * same users.id (`idFromName(users.id)`).
   */
  userId?: string;
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

export type StartInput = Pick<Quiz, "userId" | "categoryId" | "category" | "difficulty" | "mode" | "length"> & {
  questions: AssembledQuestion[];
};

/** A quiz under `quiz:done:*`: finished and scored. What the flush writes. */
export type FinishedQuiz = Quiz & { finishedAt: string; score: number };

const ACTIVE = "quiz:active";
const DONE_PREFIX = "quiz:done:";
const doneKey = (quizId: string) => `${DONE_PREFIX}${quizId}`;
const LAST = "quiz:last";
const RETRIES = "flush:retries";
const PREFS = "prefs";

// Alarm backoff for flushes that failed: 5 s, 10 s, 20 s … capped at 10 min,
// forever. Never give up: the entry stays until Postgres takes it.
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 10 * 60_000;
/** From this many failed passes in a row (~30 min) every failure logs as STUCK. */
const STUCK_AFTER = 10;
/** One flush attempt (connect + transaction) gives up after this long. */
const FLUSH_TIMEOUT_MS = 20_000;
const retryDelay = (failedPasses: number) =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failedPasses - 1), RETRY_CAP_MS);

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
  /**
   * Flushes in progress in this instance, by quizId (single flight). The flush
   * awaits network I/O, and input gates do NOT hold other events back during
   * a socket read, so finish(), flush() and alarm() can interleave there. Every
   * caller for the same quiz shares one promise, so there is only ever one
   * writer, and only that writer deletes the entry, after its COMMIT.
   * In memory on purpose: if the instance dies, so does its in-flight flush.
   */
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Safety net for entries with no alarm behind them (quizzes finished before
    // STM-10 shipped, or anything else unforeseen): whenever this object wakes
    // with unflushed quizzes and no alarm, schedule one now.
    ctx.blockConcurrencyWhile(async () => {
      if (this.pendingQuizIds().length > 0 && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now());
      }
    });
  }

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
      // Not flushed yet, or the most recent one that was (a retried finish
      // whose first response got lost still gets its result back).
      const last = this.kv.get<Quiz>(LAST);
      const done = this.kv.get<Quiz>(doneKey(quizId)) ?? (last?.quizId === quizId ? last : undefined);
      return done ? { ok: true, alreadyFinished: true, result: toResult(done) } : { ok: false, code: "no_quiz" };
    }

    quiz.finishedAt = new Date().toISOString();
    quiz.score = quiz.answers.filter((a) => a.correct).length;
    // These three writes happen in one synchronous turn with no await between
    // them, so they commit atomically (write coalescing), and the output gate
    // holds our reply until they are durable. So the finished quiz never exists
    // without its safety-net alarm. The route then calls flush() for the fast
    // path; if that fails or never runs, this alarm retries. Moving an earlier
    // pending alarm back by up to RETRY_BASE_MS is harmless.
    this.kv.put(doneKey(quiz.quizId), quiz);
    this.kv.delete(ACTIVE);
    void this.ctx.storage.setAlarm(Date.now() + RETRY_BASE_MS);
    return { ok: true, alreadyFinished: false, result: toResult(quiz) };
  }

  // -------------------------------------------------------------------------
  // Flush to Postgres (STM-10)
  // -------------------------------------------------------------------------

  private pendingQuizIds(): string[] {
    return [...this.kv.list({ prefix: DONE_PREFIX })].map(([key]) => key.slice(DONE_PREFIX.length));
  }

  /**
   * Write finished quiz `quizId` to Postgres, then delete it here. Resolves
   * true when Postgres has it (now or earlier; also when there is no such
   * entry), false when the write failed and the entry is kept for the alarm.
   * Never throws. The route awaits this right after finish().
   */
  flush(quizId: string): Promise<boolean> {
    const running = this.inFlight.get(quizId);
    if (running) return running;
    const quiz = this.kv.get<FinishedQuiz>(doneKey(quizId));
    if (!quiz) return Promise.resolve(true); // flushed earlier (or never finished)

    const attempt = this.writeThenDelete(quiz).finally(() => this.inFlight.delete(quizId));
    this.inFlight.set(quizId, attempt);
    return attempt;
  }

  private async writeThenDelete(quiz: FinishedQuiz): Promise<boolean> {
    const started = Date.now();
    try {
      const userId = quiz.userId ?? this.ctx.id.name;
      if (!userId) throw new Error("quiz has no userId and the object has no name");
      // Bounded, so a hung connection can't hold the single-flight slot forever.
      // If it times out but commits later anyway, the next attempt hits ON
      // CONFLICT; only an attempt that saw its own commit (or conflict) deletes.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const inserted = await Promise.race([
        withDb(this.env, this.ctx, (db) => writeFinishedSession(db, userId, quiz)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`flush timed out after ${FLUSH_TIMEOUT_MS} ms`)), FLUSH_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      // Only now, after COMMIT resolved, is our copy deleted. A crash between
      // the two leaves the entry; the next attempt hits ON CONFLICT and lands here.
      // Both writes are in one synchronous turn, so they commit together.
      const last = this.kv.get<FinishedQuiz>(LAST);
      if (!last || last.finishedAt <= quiz.finishedAt) this.kv.put(LAST, quiz); // newest finish wins
      this.kv.delete(doneKey(quiz.quizId));
      console.log(
        JSON.stringify({ event: "session_flush_ok", quizId: quiz.quizId, inserted, ms: Date.now() - started }),
      );
      return true;
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "session_flush_failed",
          quizId: quiz.quizId,
          error: err instanceof Error ? err.message : String(err),
          // Drizzle wraps driver errors ("Failed query: …"); the real reason is the cause.
          cause: err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined,
          ms: Date.now() - started,
        }),
      );
      return false;
    }
  }

  /**
   * Retry every unflushed quiz, each independently (one bad entry never blocks
   * the others). Alarms are at-least-once and may overlap a flush() from a
   * request; the single-flight map and the idempotency key make both harmless.
   *
   * It never throws: the runtime only retries a throwing alarm 6 times, and
   * this must retry forever. Instead, while anything is left, it schedules the
   * next pass itself with exponential backoff (5 s … 10 min cap). There is one
   * alarm per object, so one pass covers every entry.
   */
  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const pending = this.pendingQuizIds();
    let failed = 0;
    for (const quizId of pending) {
      if (!(await this.flush(quizId))) failed++;
    }
    if (failed === 0) this.kv.delete(RETRIES);
    // Re-read: a quiz finished while we were awaiting is pending too.
    const left = this.pendingQuizIds().length;
    if (left === 0) return;

    // Back off only on real failures; a newcomer just gets the base delay.
    const passes = failed > 0 ? (this.kv.get<number>(RETRIES) ?? 0) + 1 : 0;
    if (failed > 0) this.kv.put(RETRIES, passes);
    const delayMs = failed > 0 ? retryDelay(passes) : RETRY_BASE_MS;
    // One alarm per object: keep whichever is earlier, so a newer finish()'s
    // alarm is never pushed back by this pass's backoff.
    const next = Date.now() + delayMs;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > next) await this.ctx.storage.setAlarm(next);
    if (failed === 0) return;
    const log = {
      event: passes >= STUCK_AFTER ? "session_flush_STUCK" : "session_flush_retry_scheduled",
      object: this.ctx.id.toString(),
      pending: left,
      failedThisPass: failed,
      failedPasses: passes,
      nextInMs: delayMs,
      runtimeRetryCount: info?.retryCount ?? 0,
    };
    // STUCK: a friend's results have been waiting ~30 min or more. Loud on purpose.
    (passes >= STUCK_AFTER ? console.error : console.warn)(JSON.stringify(log));
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

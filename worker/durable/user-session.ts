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
 *   gen:window           today's generation count: reset time, time zone, counted sourceIds (STM-24)
 *
 * Every quiz has a public `quizId` (random, opaque) that the client sends back
 * with each answer and with finish, so a late retry meant for an earlier quiz
 * can never land on the one in progress. The idempotency key is separate and
 * never leaves the object.
 *
 * The snapshot holds the full question (answer and explanation included). It
 * never leaves the object except through `toPublicQuiz` / `toResult`
 * (worker/quiz/session-state.ts, which holds the quiz rules; this file holds
 * the storage, the flush and the alarm).
 */
import { DurableObject } from "cloudflare:workers";
import { withDb } from "../db/client";
import { withTimeout } from "../lib/timeout";
import { writeFinishedSession } from "../quiz/flush";
import { currentWindow, parseDailyCap, refundIn, reserveIn, type CapWindow } from "../limits/daily-cap";
import { mergePrefs, readPrefs, type Prefs, type PrefsPatch } from "../quiz/schemas";
import {
  answerQuiz,
  newQuiz,
  scoreQuiz,
  toPublicQuiz,
  toResult,
  type AnswerOutcome,
  type FinishedQuiz,
  type PublicQuiz,
  type Quiz,
  type QuizResult,
  type StartInput,
} from "../quiz/session-state";

const ACTIVE = "quiz:active";
const DONE_PREFIX = "quiz:done:";
const doneKey = (quizId: string) => `${DONE_PREFIX}${quizId}`;
const LAST = "quiz:last";
const RETRIES = "flush:retries";
const PREFS = "prefs";
const GEN_WINDOW = "gen:window";

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

    const ids = { quizId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const quiz = newQuiz(input, ids, new Date().toISOString());
    this.kv.put(ACTIVE, quiz);
    return { started: true, quiz: toPublicQuiz(quiz) };
  }

  /**
   * Answer question `index` of quiz `quizId` with option `option`, graded here
   * against the snapshot. The rules (quizId must match, strictly in order,
   * idempotent by index: a repeat gets the stored answer with `duplicate: true`)
   * are in `answerQuiz`; this stores the quiz when a new answer was added.
   */
  answer(quizId: string, index: number, option: number): AnswerOutcome {
    const quiz = this.active();
    const out = answerQuiz(quiz, quizId, index, option, new Date().toISOString());
    if (quiz && out.ok && !out.duplicate) this.kv.put(ACTIVE, quiz);
    return out;
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

    const finished = scoreQuiz(quiz, new Date().toISOString());
    // These three writes happen in one synchronous turn with no await between
    // them, so they commit atomically (write coalescing), and the output gate
    // holds our reply until they are durable. So the finished quiz never exists
    // without its safety-net alarm. The route then calls flush() for the fast
    // path; if that fails or never runs, this alarm retries. Moving an earlier
    // pending alarm back by up to RETRY_BASE_MS is harmless.
    this.kv.put(doneKey(finished.quizId), finished);
    this.kv.delete(ACTIVE);
    void this.ctx.storage.setAlarm(Date.now() + RETRY_BASE_MS);
    return { ok: true, alreadyFinished: false, result: toResult(finished) };
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
      const inserted = await withTimeout(
        withDb(this.env, this.ctx, (db) => writeFinishedSession(db, userId, quiz)),
        FLUSH_TIMEOUT_MS,
        () => {
          throw new Error(`flush timed out after ${FLUSH_TIMEOUT_MS} ms`);
        },
      );
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
    return readPrefs(this.kv.get(PREFS));
  }

  /** Merge a validated patch over the current prefs. The route validates too; this is the last line. */
  setPrefs(patch: PrefsPatch): Prefs {
    const next = mergePrefs(this.getPrefs(), patch);
    this.kv.put(PREFS, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Daily generation cap (STM-24). Rules in worker/limits/daily-cap.ts.
  // -------------------------------------------------------------------------

  private cap(): number {
    return parseDailyCap(this.env.DAILY_GENERATION_CAP);
  }

  private window(timeZone: string): CapWindow {
    return currentWindow(this.kv.get(GEN_WINDOW), Date.now(), timeZone);
  }

  /** How many runs are left today. Read-only: POST /api/uploads asks before signing. */
  generationAllowance(timeZone: string): { limit: number; used: number; remaining: number; window: CapWindow } {
    const window = this.window(timeZone);
    const limit = this.cap();
    return { limit, used: window.sourceIds.length, remaining: Math.max(0, limit - window.sourceIds.length), window };
  }

  /**
   * Count upload `sourceId` against today's cap, if there is room. Check and
   * count happen in one synchronous turn, so two completes can't both take the
   * last slot. Counting the same source again is a no-op (a retried complete).
   */
  reserveGeneration(sourceId: string, timeZone: string): { ok: boolean; counted: boolean; limit: number; window: CapWindow } {
    const limit = this.cap();
    const out = reserveIn(this.window(timeZone), sourceId, limit);
    if (out.ok && out.counted) this.kv.put(GEN_WINDOW, out.window);
    return { ok: out.ok, counted: out.ok && out.counted, limit, window: out.window };
  }

  /** The Workflow gives a count back when the run ended without spending (a duplicate, the kill switch …). */
  refundGeneration(sourceId: string): { refunded: boolean } {
    const out = refundIn(this.window("UTC"), sourceId);
    if (out.refunded) this.kv.put(GEN_WINDOW, out.window);
    return { refunded: out.refunded };
  }
}

/**
 * STM-15: the generation pipeline as a Cloudflare Workflow, one run per source
 * (started by queue.ts). Each step.do is durable: once a step returns, its
 * result is stored, and if the run is interrupted it resumes at the first step
 * that has not returned. Earlier steps are not run again. So every step must be
 * safe to run twice (it may fail half way and be retried).
 *
 *   start → extract → fingerprint → claim lock → classify → chunk → generate → filter → store → release lock
 *
 * The lock comes after the fingerprint because it is keyed by it (STM-16, see
 * lock-rules.ts). Fingerprint writes content_hash; the UNIQUE constraint makes
 * this source the bank or a duplicate of the bank. Unless the bank is already
 * finished, the run then asks the bank's GenerationLock; only the holder goes
 * on, and from then on it writes to the bank, not to its own source.
 *
 * Real: start, extract, fingerprint, claim lock, store, release lock. The rest
 * are stubs with the ticket that fills them in. Any failure ends with the
 * source (or the bank, for the lock holder) marked failed and a message the
 * user can read (sources.error).
 *
 * The extracted text is not stored in Postgres; it is the Extract step's
 * return value, which the Workflow keeps (rules.ts: MAX_TEXT_CHARS).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withDb } from "../db/client";
import { sources } from "../db/schema";
import { extractSource, type ExtractInput } from "../extract";
import { claimContentHash, reopenBank } from "./bank";
import {
  GENERATION_FAILED,
  GENERATION_NOT_LIVE,
  TOO_MUCH_TEXT,
  allowedFrom,
  fitsInStepResult,
  stubQuestions,
  type RunStatus,
} from "./rules";

export type GenerationParams = { sourceId: string };

/** Talks to Postgres or the GenerationLock. A dropped connection is worth several tries. */
const DB_STEP = {
  retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
  timeout: "30 seconds",
} satisfies WorkflowStepConfig;

/**
 * Reads R2 and may fetch a page or captions. extractSource() says whether a
 * failure is worth retrying (a timeout, rate limiting); most are not.
 */
const EXTRACT_STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} satisfies WorkflowStepConfig;

/** The stubs do no I/O. One retry covers the runtime restarting mid-step. */
const STUB_STEP = {
  retries: { limit: 1, delay: "1 second" },
  timeout: "30 seconds",
} satisfies WorkflowStepConfig;

/** The bank this run fills, once it holds the bank's lock. */
type Bank = { sourceId: string; fingerprint: string };
type Claimed = { generate: true } | { generate: false; reason: "busy" | "finished"; heldBy?: string };

type SourceToRead = { kind: "pdf" | "article" | "youtube"; r2Key: string | null; url: string | null };
type Extract = { ok: true; text: string; fingerprint: string } | { ok: false; code: string; message: string };
type StepContext = { step: { name: string }; attempt: number };

export class GenerationWorkflow extends WorkflowEntrypoint<Env, GenerationParams> {
  async run(event: WorkflowEvent<GenerationParams>, step: WorkflowStep) {
    const { sourceId } = event.payload;
    const log = (fields: Record<string, unknown>) =>
      JSON.stringify({ instanceId: event.instanceId, sourceId, ...fields });

    // Wraps each step body with a log line, so a run's history shows exactly
    // which steps ran and on which attempt. Ids only, no PII.
    const logged =
      <T>(body: (ctx: StepContext) => Promise<T>) =>
      async (ctx: StepContext): Promise<T> => {
        const started = Date.now();
        try {
          const result = await body(ctx);
          console.log(log({ event: "generation_step_ok", step: ctx.step.name, attempt: ctx.attempt, ms: Date.now() - started }));
          return result;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.warn(log({ event: "generation_step_failed", step: ctx.step.name, attempt: ctx.attempt, error }));
          throw err;
        }
      };

    let failure: { code: string; message: string };
    // Set once this run holds the bank's lock. Only then does it write to the bank.
    let bank: Bank | null = null;
    // Set once content_hash is written: from then on this run's own row is either
    // the bank (written only under the lock) or a duplicate, and is left alone.
    let fingerprinted = false;
    try {
      const source = await step.do("start", DB_STEP, logged(() => this.moveSource(sourceId, "processing")));
      if (!source) {
        // Gone, or already finished by an earlier run. Nothing to do.
        console.log(log({ event: "generation_skipped" }));
        return { sourceId, outcome: "skipped" };
      }

      const extracted = await step.do("extract", EXTRACT_STEP, logged((ctx) => this.extract(source, ctx.attempt)));

      if (extracted.ok) {
        const { fingerprint } = extracted;
        const fp = await step.do(
          "fingerprint",
          DB_STEP,
          logged(() => withDb(this.env, this.ctx, (db) => claimContentHash(db, sourceId, fingerprint))),
        );
        fingerprinted = true;
        if (fp.next === "done") {
          // The bank is finished (ready or refused) and this upload now shares it.
          console.log(log({ event: "generation_bank_exists", bankSourceId: fp.bankSourceId, bankStatus: fp.bankStatus }));
          return { sourceId, outcome: "duplicate", bankSourceId: fp.bankSourceId };
        }
        const claimed = await step.do("claim lock", DB_STEP, logged(() => this.claimBank(fp.bankSourceId, fingerprint, sourceId)));
        if (!claimed.generate) {
          // Another run holds the lock and will finish the bank for everyone,
          // or the bank finished while this run was on its way.
          console.log(log({ event: "generation_lock_not_ours", bankSourceId: fp.bankSourceId, reason: claimed.reason, heldBy: claimed.heldBy }));
          return { sourceId, outcome: claimed.reason === "busy" ? "waiting_on_other_run" : "duplicate", bankSourceId: fp.bankSourceId };
        }
        bank = { sourceId: fp.bankSourceId, fingerprint };

        // TODO(STM-21/22): sample chunks from start, middle and end; refuse off-topic sources.
        await step.do("classify", STUB_STEP, logged(async () => ({ verdict: "accepted" as const })));
        // TODO(STM-17): real chunks with heading paths and char ranges.
        const chunks = await step.do("chunk", STUB_STEP, logged(async () => [{ start: 0, end: extracted.text.length }]));
        // TODO(STM-18): generate through AI Gateway, Zod-validate, retry once, drop.
        const drafts = await step.do("generate", STUB_STEP, logged(async () => stubQuestions(fingerprint)));
        // TODO(STM-19): rubric score and vector near-duplicate filter.
        const kept = await step.do("filter", STUB_STEP, logged(async () => drafts));
        // TODO(STM-18): write the questions and mark the bank ready, in one transaction, through writeBank (lock renewed first).
        // For now nothing is written to the bank and the user is told why.
        const held = bank;
        await step.do("store", DB_STEP, logged(() => this.writeBank(held, sourceId, "failed", GENERATION_NOT_LIVE)));
        await step.do("release lock", DB_STEP, logged(() => this.release(held, sourceId)));
        return { sourceId, outcome: "stubbed", bankSourceId: bank.sourceId, chunks: chunks.length, questions: kept.length };
      }
      failure = extracted;
    } catch (err) {
      // A step ran out of retries or threw NonRetryableError. The user gets a
      // general message; the log has the reason.
      console.error(log({ event: "generation_run_failed", error: err instanceof Error ? err.message : String(err) }));
      failure = { code: "step_failed", message: GENERATION_FAILED };
    }

    const held = bank;
    if (held) {
      await step.do("mark failed", DB_STEP, logged(() => this.writeBank(held, sourceId, "failed", failure.message)));
      await step.do("release lock", DB_STEP, logged(() => this.release(held, sourceId)));
    } else if (!fingerprinted) {
      await step.do("mark failed", DB_STEP, logged(() => this.moveSource(sourceId, "failed", failure.message)));
    } else {
      // Failed between the fingerprint and getting the lock (the lock step ran
      // out of retries). This run never held the bank, so it writes nothing to
      // it; the next upload of the same file can claim it.
      console.error(log({ event: "generation_failed_without_lock" }));
    }
    // Ends the run as errored, so failures stand out in `wrangler workflows instances list`.
    throw new Error(`source failed: ${failure.code}`);
  }

  private lock(fingerprint: string) {
    return this.env.GENERATION_LOCK.get(this.env.GENERATION_LOCK.idFromName(fingerprint));
  }

  /** Give the lock back (a plain object: RPC results can't be step results as they are). */
  private async release(bank: Bank, holder: string): Promise<{ released: boolean }> {
    const { released } = await this.lock(bank.fingerprint).release(holder);
    return { released };
  }

  /**
   * Ask the bank's lock for this run (holder = this run's sourceId). With it,
   * reopen the bank if this run may generate it; if not, give the lock back.
   * Re-runnable: a repeat claim by the same holder is a renewal.
   */
  private async claimBank(bankSourceId: string, fingerprint: string, holder: string): Promise<Claimed> {
    const lock = this.lock(fingerprint);
    const claim = await lock.claim(holder);
    if (!claim.granted) return { generate: false, reason: "busy", heldBy: claim.holder };
    const reopened = await withDb(this.env, this.ctx, (db) => reopenBank(db, bankSourceId, holder));
    if (reopened) return { generate: true };
    await lock.release(holder);
    return { generate: false, reason: "finished" };
  }

  /**
   * A write to the bank by the lock holder. The lease is renewed first; if
   * another run has taken the lock over (this run's lease ran out), nothing is
   * written and that run's result stands.
   */
  private async writeBank(bank: Bank, holder: string, to: RunStatus, error: string | null): Promise<{ written: boolean }> {
    const { renewed } = await this.lock(bank.fingerprint).renew(holder);
    if (!renewed) {
      console.warn(JSON.stringify({ event: "generation_write_skipped_lock_lost", sourceId: holder, bankSourceId: bank.sourceId }));
      return { written: false };
    }
    return { written: (await this.moveSource(bank.sourceId, to, error)) !== null };
  }

  /**
   * Move the source to `to`, only from a status rules.ts allows. Returns what
   * extraction needs, or null when the row is gone or in another status (an
   * earlier run already finished it).
   */
  private moveSource(sourceId: string, to: RunStatus, error: string | null = null): Promise<SourceToRead | null> {
    return withDb(this.env, this.ctx, async (db) => {
      const [row] = await db
        .update(sources)
        .set({ status: to, error, updatedAt: sql`now()` })
        .where(and(eq(sources.id, sourceId), inArray(sources.status, allowedFrom(to))))
        .returning({ kind: sources.kind, r2Key: sources.r2Key, url: sources.url });
      return row ?? null;
    });
  }

  /**
   * Retryable failures (a timeout, rate limiting) throw, so the step is
   * retried, except on the last attempt: then the failure is returned like any
   * other, and the user gets its specific message. Attempts count from 1.
   */
  private async extract(source: SourceToRead, attempt: number): Promise<Extract> {
    const result = await extractSource(await this.extractInput(source));
    if (!result.ok) {
      if (result.retryable && attempt <= EXTRACT_STEP.retries.limit) throw new Error(`retryable: ${result.code}`);
      return { ok: false, code: result.code, message: result.message };
    }
    if (!fitsInStepResult(result.text)) return { ok: false, code: "too_much_text", message: TOO_MUCH_TEXT };
    return { ok: true, text: result.text, fingerprint: result.fingerprint };
  }

  private async extractInput(source: SourceToRead): Promise<ExtractInput> {
    if (source.kind === "pdf") {
      const object = source.r2Key ? await this.env.UPLOADS.get(source.r2Key) : null;
      if (!object) throw new NonRetryableError("the uploaded PDF is not in R2");
      return { kind: "pdf", bytes: new Uint8Array(await object.arrayBuffer()) };
    }
    if (!source.url) throw new NonRetryableError(`${source.kind} source has no url`);
    return { kind: source.kind, url: source.url };
  }
}

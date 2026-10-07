/**
 * STM-15: the generation pipeline as a Cloudflare Workflow, one run per source
 * (started by queue.ts). Each step.do is durable: once a step returns, its
 * result is stored, and if the run is interrupted it resumes at the first step
 * that has not returned. Earlier steps are not run again. So every step must be
 * safe to run twice (it may fail half way and be retried).
 *
 *   start → claim lock → extract → fingerprint → classify → chunk → generate → filter → store
 *
 * Only start, extract and store are real here. The others are stubs with the
 * ticket that fills them in. Any failure ends with the source marked failed
 * and a message the user can read (sources.error).
 *
 * The extracted text is not stored in Postgres; it is the Extract step's
 * return value, which the Workflow keeps (rules.ts: MAX_TEXT_CHARS).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chunkSource, type ChunkInput } from "../chunk";
import { withDb } from "../db/client";
import { sources } from "../db/schema";
import { extractSource, type ExtractInput } from "../extract";
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

/** Talks to Postgres. A dropped connection is worth several tries. */
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

type SourceToRead = { kind: "pdf" | "article" | "youtube"; r2Key: string | null; url: string | null };
type Extract =
  | { ok: true; text: string; fingerprint: string; title: ChunkInput["title"]; spans: ChunkInput["spans"] }
  | { ok: false; code: string; message: string };
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
    try {
      const source = await step.do("start", DB_STEP, logged(() => this.moveSource(sourceId, "processing")));
      if (!source) {
        // Gone, or already finished by an earlier run. Nothing to do.
        console.log(log({ event: "generation_skipped" }));
        return { sourceId, outcome: "skipped" };
      }

      // TODO(STM-16): claim the per-content-hash generation lock (Durable Object).
      await step.do("claim lock", STUB_STEP, logged(async () => ({ claimed: true })));

      const extracted = await step.do("extract", EXTRACT_STEP, logged((ctx) => this.extract(source, ctx.attempt)));

      if (extracted.ok) {
        // TODO(STM-16): write content_hash; if a bank already exists for it, mark duplicate and stop.
        await step.do("fingerprint", STUB_STEP, logged(async () => ({ fingerprint: extracted.fingerprint, bankExists: false })));
        // TODO(STM-21/22): sample chunks from start, middle and end; refuse off-topic sources.
        await step.do("classify", STUB_STEP, logged(async () => ({ verdict: "accepted" as const })));
        const chunks = await step.do("chunk", STUB_STEP, logged(async () => chunkSource({ kind: source.kind, ...extracted })));
        // TODO(STM-18): generate through AI Gateway, Zod-validate, retry once, drop.
        const drafts = await step.do("generate", STUB_STEP, logged(async () => stubQuestions(extracted.fingerprint)));
        // TODO(STM-19): rubric score and vector near-duplicate filter.
        const kept = await step.do("filter", STUB_STEP, logged(async () => drafts));
        // TODO(STM-18): write the questions and mark the source ready, in one transaction.
        // For now nothing is written to the bank and the user is told why.
        await step.do("store", DB_STEP, logged(() => this.moveSource(sourceId, "failed", GENERATION_NOT_LIVE)));
        return { sourceId, outcome: "stubbed", chunks: chunks.length, questions: kept.length };
      }
      failure = extracted;
    } catch (err) {
      // A step ran out of retries or threw NonRetryableError. The user gets a
      // general message; the log has the reason.
      console.error(log({ event: "generation_run_failed", error: err instanceof Error ? err.message : String(err) }));
      failure = { code: "step_failed", message: GENERATION_FAILED };
    }

    await step.do("mark failed", DB_STEP, logged(() => this.moveSource(sourceId, "failed", failure.message)));
    // Ends the run as errored, so failures stand out in `wrangler workflows instances list`.
    throw new Error(`source failed: ${failure.code}`);
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
    return { ok: true, text: result.text, fingerprint: result.fingerprint, title: result.title, spans: result.spans };
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

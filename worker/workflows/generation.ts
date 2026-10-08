/**
 * STM-15: the generation pipeline as a Cloudflare Workflow, one run per source
 * (started by queue.ts). Each step.do is durable: once a step returns, its
 * result is stored, and if the run is interrupted it resumes at the first step
 * that has not returned. Earlier steps are not run again. So every step must be
 * safe to run twice (it may fail half way and be retried).
 *
 *   start → extract → fingerprint → claim lock → generation enabled → reserve spend → chunk → classify → record gate
 *     → generate chunk n (one per picked chunk, side by side) → grade → filter → record spend → store → release lock
 *   refused by the gate: … → record gate (bank refused) → record spend → release lock
 *
 * STM-24: "reserve spend" is the spend ceiling's gate (worker/limits/spend.ts):
 * no model is called unless this month's spend plus one run's reservation fits
 * under SPEND_CEILING_USD, also for runs that were queued before the ceiling
 * was reached. A run that has reserved finishes. "record spend" writes the real
 * cost to model_calls. A run that ends without reserving gives the uploader's
 * daily-cap count back ("refund daily cap").
 *
 * STM-22: the topic gate. Classify reads the first, middle and last chunk, so
 * it comes after chunk; it calls models (embeddings, sometimes Haiku), so it
 * comes after reserve spend, like every model call. "record gate" writes the
 * decision onto the bank; a refusal ends the bank `refused` with the off-topic
 * message, and every later upload of the same text shares it (STM-16). The
 * classifier failing on its last attempt fails the run: an unchecked source is
 * never generated.
 *
 * The lock comes after the fingerprint because it is keyed by it (STM-16, see
 * lock-rules.ts). Fingerprint writes content_hash; the UNIQUE constraint makes
 * this source the bank or a duplicate of the bank. Unless the bank is already
 * finished, the run then asks the bank's GenerationLock; only the holder goes
 * on, and from then on it writes to the bank, not to its own source.
 *
 * Real: start, extract, fingerprint, claim lock, chunk, generate (one step per
 * picked chunk, STM-18), grade and filter (STM-19: rubric score, near-duplicate
 * collapse, cap), store, release lock, and the topic gate (STM-22). Any failure ends with the source (or the
 * bank, for the lock holder) marked failed and a message the user can read
 * (sources.error).
 *
 * The extracted text is not stored in Postgres; it is the Extract step's
 * return value, which the Workflow keeps (rules.ts: MAX_TEXT_CHARS).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chunkSource, type Chunk, type ChunkInput } from "../chunk";
import { sampleChunks } from "../chunk/sample";
import { classifierFor } from "../classifier/backends";
import type { Classification } from "../classifier";
import { withDb } from "../db/client";
import { sources } from "../db/schema";
import { extractSource, type ExtractInput } from "../extract";
import { anthropicGrader, anthropicModel } from "./anthropic";
import { claimContentHash, recordGate, reopenBank } from "./bank";
import { classifySpend, gateDecision } from "./gate";
import { embedTexts } from "./embed";
import { GRADER_MODEL, countOutcomes, embeddingText, filterQuestions, gradeQuestions, graderCostUsd, passingIndexes } from "./filter";
import { MIN_QUESTIONS, MODEL, costUsd, generateForChunk, planChunks, spreadAnswers, totalUsage } from "./generate";
import { EMBEDDING_MODEL } from "./embed";
import { SPEND_CEILING_MESSAGE, parseSpendCeiling, stableUuid } from "../limits/spend";
import { recordRunSpend, reserveRunSpend, type SpendRow } from "../limits/spend-db";
import { GENERATION_FAILED, GENERATION_OFF, TOO_MUCH_TEXT, TOO_THIN, allowedFrom, fitsInStepResult, type RunStatus } from "./rules";
import { storeBank } from "./store";
import type { KeptQuestion } from "./filter";

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

/**
 * One chunk: one model call, or two when the first reply is invalid. The SDK
 * already retries a failed request twice (anthropic.ts), so a step retry means
 * the provider or gateway is struggling; wait before trying again. A finished
 * chunk's result is stored, so a resumed run never pays for it twice.
 */
const GENERATE_STEP = {
  retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

/**
 * STM-19: one Haiku call grading every question. The SDK already retries a
 * failed request twice; one step retry after that. A run pays for at most two
 * grading calls (~$0.02 each). On the last attempt, or a request that can't
 * succeed, the questions go on unscored (filter.ts).
 */
const GRADE_STEP = {
  retries: { limit: 1, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} satisfies WorkflowStepConfig;

/** One Workers AI call. On the last attempt a failure skips the near-duplicate check instead. */
const EMBED_STEP = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} satisfies WorkflowStepConfig;

/**
 * STM-22: the topic gate. Two Workers AI embedding calls, and one Haiku call
 * when the embeddings are unsure (the SDK retries that request twice first).
 * Out of retries, the run fails: a source is never generated unchecked.
 */
const CLASSIFY_STEP = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "3 minutes",
} satisfies WorkflowStepConfig;

/** The stubs do no I/O. One retry covers the runtime restarting mid-step. */
const STUB_STEP = {
  retries: { limit: 1, delay: "1 second" },
  timeout: "30 seconds",
} satisfies WorkflowStepConfig;

/** The bank this run fills, once it holds the bank's lock. */
type Bank = { sourceId: string; fingerprint: string };
type Claimed = { generate: true } | { generate: false; reason: "busy" | "finished"; heldBy?: string };

type SourceToRead = { kind: "pdf" | "article" | "youtube"; r2Key: string | null; url: string | null; ownerId?: string | null };
type Extract =
  | { ok: true; text: string; fingerprint: string; title: ChunkInput["title"]; spans: ChunkInput["spans"] }
  | { ok: false; code: string; message: string };
type StepContext = { step: { name: string }; attempt: number };

/** A run that ends on purpose, with a message for the user (thrown outside steps only). */
class RunFailure extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
  ) {
    super(code);
  }
}

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
    // STM-24: set once the spend ceiling let this run reserve. A run that ends
    // without it never called a model, so its upload doesn't count against the cap.
    let reserved = false;
    let owner: string | null = null;
    const reservationId = await stableUuid(event.instanceId, "reservation");
    const refundIfUnspent = async () => {
      const userId = owner;
      if (reserved || !userId) return;
      try {
        await step.do("refund daily cap", DB_STEP, logged(() => this.refundCap(userId, sourceId)));
      } catch {
        // Never fails the run: the worst case is one count too many until the user's midnight.
        console.error(log({ event: "daily_cap_refund_failed" }));
      }
    };
    try {
      const source = await step.do("start", DB_STEP, logged(() => this.moveSource(sourceId, "processing")));
      if (!source) {
        // Gone, or already finished by an earlier run. Nothing to do.
        console.log(log({ event: "generation_skipped" }));
        return { sourceId, outcome: "skipped" };
      }
      owner = source.ownerId ?? null;

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
          await refundIfUnspent();
          return { sourceId, outcome: "duplicate", bankSourceId: fp.bankSourceId };
        }
        const claimed = await step.do("claim lock", DB_STEP, logged(() => this.claimBank(fp.bankSourceId, fingerprint, sourceId)));
        if (!claimed.generate) {
          // Another run holds the lock and will finish the bank for everyone,
          // or the bank finished while this run was on its way.
          console.log(log({ event: "generation_lock_not_ours", bankSourceId: fp.bankSourceId, reason: claimed.reason, heldBy: claimed.heldBy }));
          await refundIfUnspent();
          return { sourceId, outcome: claimed.reason === "busy" ? "waiting_on_other_run" : "duplicate", bankSourceId: fp.bankSourceId };
        }
        bank = { sourceId: fp.bankSourceId, fingerprint };
        const held = bank;

        // The kill switch (wrangler.jsonc), read in a step so a resumed run sees the value it started with.
        const enabled = await step.do("generation enabled", STUB_STEP, logged(async () => this.env.GENERATION_ENABLED === "true"));
        if (!enabled) throw new RunFailure("generation_off", GENERATION_OFF);

        // STM-24: the spend ceiling. Nothing below calls a model unless this reserved.
        const spend = await step.do(
          "reserve spend",
          DB_STEP,
          logged(() => this.reserveSpend(reservationId, sourceId, source.ownerId ?? null)),
        );
        console.log(log({ event: spend.allowed ? "spend_reserved" : "spend_ceiling_reached", spentUsd: spend.spentUsd, ceilingUsd: spend.ceilingUsd }));
        if (!spend.allowed) throw new RunFailure("spend_ceiling", SPEND_CEILING_MESSAGE);
        reserved = true;

        const chunks = await step.do("chunk", STUB_STEP, logged(async () => chunkSource({ kind: source.kind, ...extracted })));

        // STM-22: the topic gate, on the first, middle and last chunk (the samples the STM-21 benchmark measured).
        const samples = sampleChunks(extracted.text, chunks);
        const gate = await step.do(
          "classify",
          CLASSIFY_STEP,
          logged(async (ctx) => ({ ...(await classifierFor(this.env).classify(samples.map((s) => s.text))), attempt: ctx.attempt })),
        );
        const decision = gateDecision(samples, gate);
        await step.do(
          "record gate",
          DB_STEP,
          logged(async () => {
            const written = await this.recordGate(held, sourceId, decision);
            console.log(
              log({
                event: "generation_gate_decision",
                bankSourceId: held.sourceId,
                verdict: gate.verdict,
                confidence: Number(gate.confidence.toFixed(3)),
                classifiedBy: gate.by,
                detected: gate.detected,
                fellThrough: Boolean(gate.primary),
                costUsd: Number(gate.costUsd.toFixed(6)),
                written,
              }),
            );
            return { written };
          }),
        );
        if (gate.verdict === "refused") {
          // The bank is refused (record gate). Record the classifier's spend, release the reservation and the lock.
          const gateRows = await this.gateSpendRows(event.instanceId, sourceId, source.ownerId ?? null, gate);
          const recorded = await step.do(
            "record spend",
            DB_STEP,
            logged(() => withDb(this.env, this.ctx, (db) => recordRunSpend(db, reservationId, gateRows, gate.attempt === 1))),
          );
          console.log(log({ event: "spend_recorded", rows: gateRows.length, recordedUsd: recorded.recordedUsd, reservationReleased: gate.attempt === 1 }));
          await step.do("release lock", DB_STEP, logged(() => this.release(held, sourceId)));
          return { sourceId, outcome: "refused", bankSourceId: held.sourceId, detected: gate.detected };
        }

        const plan = planChunks(chunks);
        // One step per chunk, run side by side: a retry or a resume repeats only the chunks that hadn't finished.
        const results = await Promise.all(
          plan.chunks.map((chunk) =>
            step.do(
              `generate chunk ${chunk.ordinal}`,
              GENERATE_STEP,
              logged(async (ctx) => {
                const result = await generateForChunk(anthropicModel(this.env), chunk, extracted.text, plan.perChunk);
                const { questions, ...counts } = result;
                console.log(log({ event: "generation_chunk_done", ...counts, kept: questions.length }));
                // An attempt above 1 means an earlier one failed, possibly after being billed (record spend).
                return { ...result, attempt: ctx.attempt };
              }),
            ),
          ),
        );
        const generated = results.flatMap((r) => r.questions);
        // STM-19: grade every question against the rubric (one Haiku call). If grading
        // can't be done, the questions go on unscored rather than failing the run.
        const graded = await step.do(
          "grade",
          GRADE_STEP,
          logged(async (ctx) => {
            try {
              const out = await gradeQuestions(anthropicGrader(this.env), generated, plan.chunks, extracted.text);
              return { ok: true as const, attempt: ctx.attempt, ...out };
            } catch (err) {
              if (!(err instanceof NonRetryableError) && ctx.attempt <= GRADE_STEP.retries.limit) throw err;
              const error = err instanceof Error ? err.message : String(err);
              console.warn(log({ event: "generation_filter_degraded", stage: "grade", attempt: ctx.attempt, error }));
              return { ok: false as const, attempt: ctx.attempt, grades: generated.map(() => null), usage: { inputTokens: 0, outputTokens: 0 } };
            }
          }),
        );
        // Embed what passed the rubric, collapse near-duplicates, cap. Kept questions carry their score and vector to the store step.
        const filtered = await step.do(
          "filter",
          EMBED_STEP,
          logged(async (ctx) => {
            const passing = passingIndexes(graded.grades);
            const vectors: (number[] | null)[] = generated.map(() => null);
            let embedCostUsd = 0;
            let embedded = true;
            try {
              const e = await embedTexts(this.env.AI, passing.map((i) => embeddingText(generated[i]!)));
              passing.forEach((i, k) => (vectors[i] = e.vectors[k]!));
              embedCostUsd = e.costUsd;
            } catch (err) {
              if (ctx.attempt <= EMBED_STEP.retries.limit) throw err;
              embedded = false;
              const error = err instanceof Error ? err.message : String(err);
              console.warn(log({ event: "generation_filter_degraded", stage: "embed", attempt: ctx.attempt, error }));
            }
            const { kept, decisions } = filterQuestions(generated, graded.grades, vectors);
            const counts = countOutcomes(decisions);
            const generation = totalUsage(results);
            const generationCostUsd = costUsd(generation);
            const gradeCostUsd = graderCostUsd(graded.usage);
            console.log(
              log({
                event: "generation_filter_summary",
                generated: generated.length,
                belowThreshold: counts.below_threshold,
                nearDuplicate: counts.near_duplicate,
                capped: counts.capped,
                kept: counts.kept,
                graded: graded.ok,
                unscored: graded.grades.filter((g) => g === null).length,
                embedded,
                gradeInputTokens: graded.usage.inputTokens,
                gradeOutputTokens: graded.usage.outputTokens,
                gradeCostUsd: Number(gradeCostUsd.toFixed(4)),
                embedCostUsd: Number(embedCostUsd.toFixed(6)),
              }),
            );
            console.log(
              log({
                event: "generation_run_summary",
                chunks: chunks.length,
                chunksAsked: results.length,
                chunksDropped: results.filter((r) => r.dropped).length,
                calls: results.reduce((n, r) => n + r.calls, 0) + (graded.ok ? 1 : 0),
                generated: generated.length,
                kept: kept.length,
                ...generation,
                generationCostUsd: Number(generationCostUsd.toFixed(4)),
                filterCostUsd: Number((gradeCostUsd + embedCostUsd).toFixed(4)),
                costUsd: Number((generationCostUsd + gradeCostUsd + embedCostUsd).toFixed(4)),
              }),
            );
            return { kept: spreadAnswers(kept), decisions, embedCostUsd };
          }),
        );

        // STM-24: the run's real spend replaces its reservation. If some cost is unknown
        // (a failed attempt that may have been billed), the reservation is kept too.
        const usageKnown = gate.attempt === 1 && results.every((r) => r.attempt === 1) && graded.ok && graded.attempt === 1;
        const spendRows = [
          ...(await this.gateSpendRows(event.instanceId, sourceId, source.ownerId ?? null, gate)),
          ...(await this.spendRows(event.instanceId, sourceId, source.ownerId ?? null, results, graded, filtered.embedCostUsd ?? 0)),
        ];
        const recorded = await step.do(
          "record spend",
          DB_STEP,
          logged(() => withDb(this.env, this.ctx, (db) => recordRunSpend(db, reservationId, spendRows, usageKnown))),
        );
        console.log(log({ event: "spend_recorded", rows: spendRows.length, recordedUsd: recorded.recordedUsd, reservationReleased: usageKnown }));

        const kept = filtered.kept;
        if (kept.length < MIN_QUESTIONS) throw new RunFailure("too_thin", TOO_THIN);

        const stored = await step.do(
          "store",
          DB_STEP,
          logged(() => this.storeBank(held, sourceId, extracted.text, chunks, kept)),
        );
        await step.do("release lock", DB_STEP, logged(() => this.release(held, sourceId)));
        // Not stored: the lock was lost (the other run's result stands), or an earlier attempt of this step already committed.
        return { sourceId, outcome: stored.stored ? "ready" : "not_stored", bankSourceId: held.sourceId, questions: kept.length };
      }
      failure = extracted;
    } catch (err) {
      if (err instanceof RunFailure) {
        // An expected end with its own message (kill switch, too thin).
        console.warn(log({ event: "generation_run_failed", code: err.code }));
        failure = { code: err.code, message: err.userMessage };
      } else {
        // A step ran out of retries or threw NonRetryableError. The user gets a
        // general message; the log has the reason.
        console.error(log({ event: "generation_run_failed", error: err instanceof Error ? err.message : String(err) }));
        failure = { code: "step_failed", message: GENERATION_FAILED };
      }
    }

    await refundIfUnspent();
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

  /** STM-24: reserve one run's spend if the month's ceiling allows it. */
  private async reserveSpend(id: string, sourceId: string, userId: string | null) {
    const ceilingUsd = parseSpendCeiling(this.env.SPEND_CEILING_USD);
    const out = await withDb(this.env, this.ctx, (db) => reserveRunSpend(db, { id, userId, sourceId, ceilingUsd, now: new Date() }));
    return { ...out, ceilingUsd };
  }

  /** STM-24: give the upload's daily-cap count back (the run never reached a model). */
  private async refundCap(userId: string, sourceId: string): Promise<{ refunded: boolean }> {
    const { refunded } = await this.env.USER_SESSION.get(this.env.USER_SESSION.idFromName(userId)).refundGeneration(sourceId);
    return { refunded };
  }

  /** One model_calls row per generate step (one or two calls), one for grading, one for embeddings. Ids are stable per run. */
  private async spendRows(
    instanceId: string,
    sourceId: string,
    userId: string | null,
    results: { chunkOrdinal: number; usage: { inputTokens: number; outputTokens: number } }[],
    graded: { ok: boolean; usage: { inputTokens: number; outputTokens: number } },
    embedCostUsd: number,
  ): Promise<SpendRow[]> {
    const row = async (label: string, r: Omit<SpendRow, "id" | "sourceId" | "userId">): Promise<SpendRow> => ({
      id: await stableUuid(instanceId, label),
      userId,
      sourceId,
      ...r,
    });
    const rows = await Promise.all(
      results.map((r) =>
        row(`generate:${r.chunkOrdinal}`, { purpose: "generate", provider: "anthropic", model: MODEL, ...r.usage, costUsd: costUsd(r.usage) }),
      ),
    );
    if (graded.ok) {
      rows.push(await row("grade", { purpose: "grade", provider: "anthropic", model: GRADER_MODEL, ...graded.usage, costUsd: graderCostUsd(graded.usage) }));
    }
    if (embedCostUsd > 0) {
      rows.push(await row("embed", { purpose: "embed", provider: "workers-ai", model: EMBEDDING_MODEL, inputTokens: 0, outputTokens: 0, costUsd: embedCostUsd }));
    }
    return rows;
  }

  /** STM-22: one model_calls row per classifier backend called (gate.ts: classifySpend). */
  private gateSpendRows(instanceId: string, sourceId: string, userId: string | null, gate: Classification): Promise<SpendRow[]> {
    return Promise.all(
      classifySpend(gate).map(async ({ label, ...r }) => ({ id: await stableUuid(instanceId, label), userId, sourceId, ...r })),
    );
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

  /** STM-22: the gate's decision onto the bank (a refusal ends it), if this run still holds the lock (see writeBank). */
  private async recordGate(bank: Bank, holder: string, decision: ReturnType<typeof gateDecision>): Promise<boolean> {
    const { renewed } = await this.lock(bank.fingerprint).renew(holder);
    if (!renewed) {
      console.warn(JSON.stringify({ event: "generation_write_skipped_lock_lost", sourceId: holder, bankSourceId: bank.sourceId }));
      return false;
    }
    return withDb(this.env, this.ctx, (db) => recordGate(db, bank.sourceId, decision));
  }

  /** Write the questions and mark the bank ready, if this run still holds the lock (see writeBank). */
  private async storeBank(bank: Bank, holder: string, text: string, chunks: Chunk[], kept: KeptQuestion[]): Promise<{ stored: boolean }> {
    const { renewed } = await this.lock(bank.fingerprint).renew(holder);
    if (!renewed) {
      console.warn(JSON.stringify({ event: "generation_write_skipped_lock_lost", sourceId: holder, bankSourceId: bank.sourceId }));
      return { stored: false };
    }
    return withDb(this.env, this.ctx, (db) => storeBank(db, bank.sourceId, text, chunks, kept));
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
        .returning({ kind: sources.kind, r2Key: sources.r2Key, url: sources.url, ownerId: sources.ownerId });
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

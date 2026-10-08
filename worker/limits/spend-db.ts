/**
 * STM-24: the Postgres side of the spend ceiling (rules in spend.ts). Called by
 * the upload routes (read-only check) and by the generation Workflow (reserve,
 * then record). Every write is safe to re-run: row ids are stable per run.
 */
import { eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { modelCalls } from "../db/schema";
import { RESERVE_PER_RUN_USD, ceilingAllows, monthStart } from "./spend";

/** Serialises reservations across all runs (pg_advisory_xact_lock key). */
const SPEND_LOCK = sql`hashtext('createmyq:spend-ceiling')`;

export const RESERVATION = { purpose: "reservation", provider: "createmyq", model: "estimate" } as const;

export type SpendRow = {
  id: string;
  userId: string | null;
  sourceId: string;
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/** Real spend plus open reservations since the start of `now`'s month (UTC). */
export async function monthSpendUsd(db: Pick<Db, "select">, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)` })
    .from(modelCalls)
    .where(gte(modelCalls.createdAt, monthStart(now)));
  return Number(row?.total ?? 0);
}

/**
 * Reserve RESERVE_PER_RUN_USD for one run if the ceiling allows it. One
 * transaction under an advisory lock: two runs can't both see room for one.
 * A re-run finds its own reservation and is allowed again.
 */
export async function reserveRunSpend(
  db: Db,
  r: { id: string; userId: string | null; sourceId: string; ceilingUsd: number; now: Date },
): Promise<{ allowed: boolean; spentUsd: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SPEND_LOCK})`);
    const spentUsd = await monthSpendUsd(tx, r.now);
    const [mine] = await tx.select({ id: modelCalls.id }).from(modelCalls).where(eq(modelCalls.id, r.id));
    if (mine) return { allowed: true, spentUsd };
    if (!ceilingAllows(spentUsd, r.ceilingUsd)) return { allowed: false, spentUsd };
    await tx.insert(modelCalls).values({
      id: r.id,
      userId: r.userId,
      sourceId: r.sourceId,
      ...RESERVATION,
      costUsd: RESERVE_PER_RUN_USD.toFixed(6),
    });
    return { allowed: true, spentUsd };
  });
}

/**
 * Write the run's real spend, and drop its reservation if `release` (every
 * call's cost is known). One transaction; rows already written are skipped.
 */
export async function recordRunSpend(db: Db, reservationId: string, rows: SpendRow[], release: boolean): Promise<{ recordedUsd: number }> {
  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(modelCalls)
        .values(rows.map((r) => ({ ...r, costUsd: r.costUsd.toFixed(6) })))
        .onConflictDoNothing({ target: modelCalls.id });
    }
    if (release) await tx.delete(modelCalls).where(eq(modelCalls.id, reservationId));
  });
  return { recordedUsd: Number(rows.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6)) };
}

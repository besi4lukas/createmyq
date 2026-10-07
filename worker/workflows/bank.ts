/**
 * STM-16: the Postgres side of the fingerprint cache. Called by the Workflow's
 * fingerprint and claim lock steps (generation.ts); both are safe to re-run.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { sourceUploads, sources } from "../db/schema";
import { afterFingerprint, mayReopen } from "./lock-rules";
import { allowedFrom, type SourceStatus } from "./rules";

const CONTENT_HASH_UNIQUE = "sources_content_hash_unique";

export type Fingerprinted = {
  /** The source whose questions this content gets: this one, or the owner of the hash. */
  bankSourceId: string;
  /** True when this source owns the hash; false when it became a duplicate. */
  owner: boolean;
  bankStatus: SourceStatus;
  next: "claim" | "done";
};

/** True for the unique violation on sources.content_hash (Drizzle wraps the pg error in `cause`). */
export function isContentHashConflict(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === "23505" && constraint === CONTENT_HASH_UNIQUE) return true;
  }
  return false;
}

/**
 * Write `fingerprint` to this source's content_hash. The UNIQUE constraint
 * decides: if another source holds it, the write fails and this source becomes
 * a duplicate of that one (the bank), and its uploaders become uploaders of the
 * bank, so the private-source rule serves them its questions.
 *
 * Re-runnable: a re-run finds content_hash already set (owner) or
 * duplicate_of_id already set (duplicate) and returns the same answer.
 */
export async function claimContentHash(db: Db, sourceId: string, fingerprint: string): Promise<Fingerprinted> {
  const [me] = await db
    .select({ status: sources.status, duplicateOfId: sources.duplicateOfId })
    .from(sources)
    .where(eq(sources.id, sourceId));
  if (!me) throw new Error("source not found");
  if (me.duplicateOfId) return { ...(await bankStatus(db, me.duplicateOfId)), owner: false };

  try {
    const [owned] = await db
      .update(sources)
      .set({ contentHash: fingerprint, updatedAt: sql`now()` })
      .where(and(eq(sources.id, sourceId), or(isNull(sources.contentHash), eq(sources.contentHash, fingerprint))))
      .returning({ status: sources.status });
    if (!owned) throw new Error("source already has a different content hash");
    return { bankSourceId: sourceId, owner: true, bankStatus: owned.status, next: afterFingerprint(owned.status) };
  } catch (err) {
    if (!isContentHashConflict(err)) throw err;
  }

  // Another source owns this content. It committed before our write failed,
  // so it is visible here.
  const bank = await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: sources.id, status: sources.status })
      .from(sources)
      .where(eq(sources.contentHash, fingerprint));
    if (!owner) throw new Error("content hash conflict but no owner found");
    await tx
      .update(sources)
      .set({ status: "duplicate", duplicateOfId: owner.id, error: null, updatedAt: sql`now()` })
      .where(and(eq(sources.id, sourceId), inArray(sources.status, allowedFrom("duplicate"))));
    // Everyone who uploaded this copy now has the bank too.
    await tx.execute(sql`
      insert into ${sourceUploads} (user_id, source_id)
      select user_id, ${owner.id}::uuid from ${sourceUploads} where source_id = ${sourceId}
      on conflict do nothing`);
    return owner;
  });
  return { bankSourceId: bank.id, owner: false, bankStatus: bank.status, next: afterFingerprint(bank.status) };
}

async function bankStatus(db: Db, bankSourceId: string): Promise<Omit<Fingerprinted, "owner">> {
  const [bank] = await db.select({ status: sources.status }).from(sources).where(eq(sources.id, bankSourceId));
  if (!bank) throw new Error("the bank source is gone");
  return { bankSourceId, bankStatus: bank.status, next: afterFingerprint(bank.status) };
}

/**
 * Called by the lock holder only. Moves the bank to `processing` if this run
 * may generate it (lock-rules.ts: mayReopen) and returns whether it did.
 * `runSourceId` is the run's own source: its upload time decides whether a
 * failed bank is retried. The status guard in the UPDATE re-checks what was read.
 */
export async function reopenBank(db: Db, bankSourceId: string, runSourceId: string): Promise<boolean> {
  const [row] = await db
    .select({
      status: sources.status,
      failedBeforeUpload: sql<boolean>`${sources.updatedAt} < (select created_at from sources where id = ${runSourceId})`,
    })
    .from(sources)
    .where(eq(sources.id, bankSourceId));
  if (!row || !mayReopen(row.status, row.failedBeforeUpload)) return false;
  const [moved] = await db
    .update(sources)
    .set({ status: "processing", error: null, updatedAt: sql`now()` })
    .where(and(eq(sources.id, bankSourceId), eq(sources.status, row.status)))
    .returning({ id: sources.id });
  return Boolean(moved);
}

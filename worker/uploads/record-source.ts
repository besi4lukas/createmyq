/**
 * Create (or find again) the caller's source row, in one transaction whose
 * answers all come from writes, never from a read of what was just written.
 *
 * Why: production reaches Postgres through Hyperdrive, which caches identical
 * read-only SELECTs for up to 60 s and does not invalidate them on writes. The
 * first version of /uploads/complete looked the source up, inserted it, then
 * ran the same lookup again: the second read was served the cached "no row"
 * and the user got "We could not find that upload" for an upload that had in
 * fact been recorded (and counted against their daily cap), never queued.
 *
 * So: the INSERT … RETURNING says whether this call created the row; a retry
 * gets the existing row back from a no-op UPDATE … RETURNING (also a write, so
 * never cached). `admit` runs only for a new row, inside the transaction: a
 * refusal rolls the row back, so a refused upload leaves nothing behind.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { sourceUploads, sources } from "../db/schema";
import type { SourceStatus } from "../workflows/rules";

/** What the caller sees of their own source. For a duplicate, `status` is the bank's. */
export type OwnSource = { id: string; title: string | null; status: SourceStatus; bankSourceId: string; createdAt: Date };

export type NewSource = {
  id: string;
  ownerId: string;
  kind: "pdf" | "article" | "youtube";
  r2Key?: string;
  url?: string;
  title: string;
};

class Refused<R> extends Error {
  constructor(readonly refusal: R) {
    super("refused");
  }
}

const columns = {
  id: sources.id,
  title: sources.title,
  status: sources.status,
  duplicateOfId: sources.duplicateOfId,
  createdAt: sources.createdAt,
};

/**
 * `admit(tx)` returns null to let a new source in, or a refusal (rolled back,
 * returned as `{ refused }`). Returns `{ source: null }` when the id belongs to
 * someone else.
 */
export async function recordSource<R>(
  db: Db,
  row: NewSource,
  admit: (tx: Pick<Db, "select">) => Promise<R | null>,
): Promise<{ refused: R } | { source: OwnSource | null; created: boolean }> {
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(sources)
        .values({ ...row, visibility: "private", status: "uploaded" })
        .onConflictDoNothing()
        .returning(columns);
      if (created) {
        const refusal = await admit(tx);
        if (refusal !== null) throw new Refused(refusal);
      }
      const own =
        created ??
        // A retry: the row is there. Read it back through a no-op write.
        (
          await tx
            .update(sources)
            .set({ updatedAt: sql`${sources.updatedAt}` })
            .where(and(eq(sources.id, row.id), eq(sources.ownerId, row.ownerId)))
            .returning(columns)
        )[0];
      if (!own) return { source: null, created: false };
      await tx.insert(sourceUploads).values({ userId: row.ownerId, sourceId: row.id }).onConflictDoNothing();

      let status = own.status;
      if (own.duplicateOfId) {
        // Display only (a cached answer is at most a minute old): the bank's status.
        const [bank] = await tx.select({ status: sources.status }).from(sources).where(eq(sources.id, own.duplicateOfId));
        status = bank?.status ?? status;
      }
      const source: OwnSource = {
        id: own.id,
        title: own.title,
        status,
        bankSourceId: own.duplicateOfId ?? own.id,
        createdAt: own.createdAt,
      };
      return { source, created: Boolean(created) };
    });
  } catch (err) {
    if (err instanceof Refused) return { refused: err.refusal as R };
    throw err;
  }
}

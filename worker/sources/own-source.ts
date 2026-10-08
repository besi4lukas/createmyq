/**
 * The caller's own source, as every status endpoint shows it. Never anyone
 * else's: a source is reachable only through the caller's `source_uploads` row.
 *
 * For a duplicate (STM-16), `status`, `error` and `questionCount` are the
 * bank's (what the user will get), and `bankSourceId` names the bank.
 * `error` is the user-facing message the Workflow stored (the gate's off-topic
 * message, the scanned-PDF message, too thin, switched off …).
 *
 * This is a read: through Hyperdrive it may be up to a minute old (CLAUDE.md,
 * "Hyperdrive caches reads"). Fine for polling a status; never use it to read
 * back a write the same request just made (record-source.ts does that).
 */
import { and, count, eq, exists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import { questions, sourceUploads, sources } from "../db/schema";
import type { SourceStatus } from "../workflows/rules";

export type SourceKind = "pdf" | "article" | "youtube";

export async function findOwnSource(db: Db, userId: string, sourceId: string) {
  const bank = alias(sources, "bank");
  const [row] = await db
    .select({
      id: sources.id,
      kind: sql<SourceKind>`${sources.kind}`,
      title: sources.title,
      url: sources.url,
      status: sql<SourceStatus>`coalesce(${bank.status}, ${sources.status})`,
      error: sql<string | null>`case when ${bank.id} is null then ${sources.error} else ${bank.error} end`,
      bankSourceId: sql<string>`coalesce(${sources.duplicateOfId}, ${sources.id})`,
      createdAt: sources.createdAt,
    })
    .from(sources)
    .leftJoin(bank, eq(bank.id, sources.duplicateOfId))
    .where(
      and(
        eq(sources.id, sourceId),
        exists(
          db
            .select()
            .from(sourceUploads)
            .where(and(eq(sourceUploads.sourceId, sources.id), eq(sourceUploads.userId, userId))),
        ),
      ),
    );
  if (!row) return null;
  // Only a ready bank has questions worth counting (approved = served).
  let questionCount = 0;
  if (row.status === "ready") {
    const [n] = await db
      .select({ n: count() })
      .from(questions)
      .where(and(eq(questions.sourceId, row.bankSourceId), eq(questions.status, "approved")));
    questionCount = n?.n ?? 0;
  }
  return { ...row, questionCount };
}

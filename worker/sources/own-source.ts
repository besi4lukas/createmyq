/**
 * The caller's own sources, as every status endpoint shows them. Never anyone
 * else's: one source is reachable only through the caller's `source_uploads`
 * row, and the list is the sources the caller uploaded (owner).
 *
 * For a duplicate (STM-16), `status`, `error`, the gate fields and
 * `questionCount` are the bank's (what the user will get), and `bankSourceId`
 * names the bank. `error` is the user-facing message the Workflow stored (the
 * gate's off-topic message, the scanned-PDF message, too thin, switched off …).
 *
 * Progress (what the inline card and the status page show as steps) is read
 * from what the run has written so far, nothing more:
 *   - `fingerprinted`: content_hash is written, or the source became a
 *     duplicate (the fingerprint step has returned);
 *   - `gateVerdict`: the topic gate's decision on the bank (record gate);
 *   - `status`: uploaded (queued), processing, ready, refused, failed.
 *
 * Hyperdrive caches identical read-only SELECTs for up to 60 s, and a write
 * does not invalidate them (CLAUDE.md). A poll that is a minute stale would
 * hide a finished run, and the list would hide a source created a moment ago.
 * Both queries select `now()`, a STABLE function, which Hyperdrive never
 * caches, so every read is fresh. (worker/testing/query-cache.ts mirrors that.)
 */
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import type { SourceStatus } from "../workflows/rules";

export type SourceKind = "pdf" | "article" | "youtube";

export type OwnSource = {
  id: string;
  kind: SourceKind;
  title: string | null;
  url: string | null;
  visibility: "private" | "group";
  status: SourceStatus;
  error: string | null;
  bankSourceId: string;
  fingerprinted: boolean;
  gateVerdict: "accepted" | "refused" | null;
  detectedNiche: string | null;
  /** 0.5–1: how sure the gate was of its verdict. */
  confidence: number | null;
  /** Approved questions in the bank; only counted once it is ready. */
  questionCount: number;
  createdAt: Date;
};

/** The newest this many sources are listed. */
export const LIST_LIMIT = 50;

function ownSources(db: Db, where: SQL, tail: SQL = sql``) {
  return db.execute<OwnSource & { asOf: unknown }>(sql`
    select
      s.id,
      s.kind,
      s.title,
      s.url,
      s.visibility,
      coalesce(b.status, s.status) as status,
      case when b.id is null then s.error else b.error end as error,
      coalesce(s.duplicate_of_id, s.id) as "bankSourceId",
      (s.content_hash is not null or s.duplicate_of_id is not null) as fingerprinted,
      case when b.id is null then s.gate_verdict else b.gate_verdict end as "gateVerdict",
      case when b.id is null then s.detected_niche else b.detected_niche end as "detectedNiche",
      case when b.id is null then s.confidence else b.confidence end as confidence,
      case when coalesce(b.status, s.status) = 'ready' then (
        select count(*)::int from questions q
        where q.source_id = coalesce(s.duplicate_of_id, s.id) and q.status = 'approved'
      ) else 0 end as "questionCount",
      s.created_at as "createdAt",
      now() as "asOf"
    from sources s
    left join sources b on b.id = s.duplicate_of_id
    where ${where}
    ${tail}
  `);
}

/** Drop the cache-busting column and normalise driver types. */
function clean(row: OwnSource & { asOf: unknown }): OwnSource {
  const rest: OwnSource & { asOf?: unknown } = { ...row };
  delete rest.asOf;
  return {
    ...rest,
    confidence: rest.confidence === null ? null : Number(rest.confidence),
    questionCount: Number(rest.questionCount),
    createdAt: new Date(rest.createdAt),
  };
}

/** One source the caller has an upload of, or null. */
export async function findOwnSource(db: Db, userId: string, sourceId: string): Promise<OwnSource | null> {
  const { rows } = await ownSources(
    db,
    sql`s.id = ${sourceId}
      and exists (select 1 from source_uploads up where up.source_id = s.id and up.user_id = ${userId})`,
  );
  return rows[0] ? clean(rows[0]) : null;
}

/**
 * The sources the caller brought, newest first, in any status (a run still
 * going is listed, so a closed card's job shows up). A duplicate is listed
 * once, as the caller's own upload; the bank it points at is someone else's
 * row and is not listed even though the caller can now read its questions.
 */
export async function listOwnSources(db: Db, userId: string): Promise<OwnSource[]> {
  const { rows } = await ownSources(
    db,
    sql`s.owner_id = ${userId}
      and exists (select 1 from source_uploads up where up.source_id = s.id and up.user_id = ${userId})`,
    sql`order by s.created_at desc, s.id limit ${LIST_LIMIT}`,
  );
  return rows.map(clean);
}

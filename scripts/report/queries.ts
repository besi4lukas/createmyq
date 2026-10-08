/**
 * STM-27: every query the cost report runs. Read-only SELECTs over sessions,
 * sources and model_calls; the caller runs them inside a READ ONLY
 * transaction. Rows come back raw (numerics as strings); report.ts turns them
 * into the report. Works on any client with `query(text, params)` (pg, PGlite).
 */
import { RESERVATION } from "../../worker/limits/spend";

export interface Queryable {
  query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export type QuizRow = { kind: string; quizzes: number; users: number; questions: number; correct: number };
export type UploadRow = {
  status: string;
  bank_status: string | null;
  fingerprinted: boolean;
  spent: boolean;
  uploads: number;
};
export type SpendRowRaw = {
  purpose: string;
  provider: string;
  model: string;
  calls: number;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
};
export type RunRow = {
  source_id: string | null;
  bank_id: string | null;
  bank_status: string | null;
  recorded_usd: string;
  held_usd: string;
  held_count: number;
  purposes: string[];
};
export type HeldRow = { source_id: string | null; bank_status: string | null; created_at: Date; cost_usd: string };
export type MonthRow = { recorded_usd: string; held_usd: string };
export type FailureRow = { status: string; error: string | null; sources: number };
export type StuckRow = { id: string; status: string; updated_at: Date };
export type FlushRow = { late: number; max_lag_seconds: number | null };

export type RawReport = {
  quizzes: QuizRow[];
  quizUsers: number;
  uploads: UploadRow[];
  uploaders: number;
  spend: SpendRowRaw[];
  runs: RunRow[];
  held: HeldRow[];
  month: MonthRow;
  failures: FailureRow[];
  stuck: StuckRow[];
  flush: FlushRow;
};

/** A source is stuck when it has sat in uploaded/processing this long (the generation lock's lease is 15 min). */
export const STUCK_AFTER_MINUTES = 30;
/** A session row written this long after the quiz finished needed the flush retry (alarm), not the first attempt. */
export const LATE_FLUSH_SECONDS = 60;

const R = RESERVATION.purpose;

export async function loadReport(db: Queryable, from: Date, to: Date, monthStart: Date): Promise<RawReport> {
  const w = [from, to];

  // Quizzes taken = finished sessions (one row per quiz, written by the flush).
  const quizzes = await db.query<QuizRow>(
    `select kind::text as kind, count(*)::int as quizzes, count(distinct user_id)::int as users,
            coalesce(sum(question_count), 0)::int as questions, coalesce(sum(score), 0)::int as correct
       from sessions where finished_at >= $1 and finished_at < $2
      group by kind order by kind`,
    w,
  );
  const quizUsers = await db.query<{ n: number }>(
    `select count(distinct user_id)::int as n from sessions where finished_at >= $1 and finished_at < $2`,
    w,
  );

  // Uploads = sources rows created in the window (each upload is its own row,
  // a duplicate too). fingerprinted: reached the fingerprint step (it holds the
  // hash, or became a duplicate of the row that does). spent: has model_calls
  // of its own (a duplicate that re-ran a failed bank).
  const uploads = await db.query<UploadRow>(
    `select s.status::text as status, b.status::text as bank_status,
            (s.content_hash is not null or s.status = 'duplicate') as fingerprinted,
            exists (select 1 from model_calls m where m.source_id = s.id) as spent,
            count(*)::int as uploads
       from sources s left join sources b on b.id = s.duplicate_of_id
      where s.created_at >= $1 and s.created_at < $2
      group by 1, 2, 3, 4 order by 1, 2, 3, 4`,
    w,
  );
  const uploaders = await db.query<{ n: number }>(
    `select count(distinct owner_id)::int as n from sources where created_at >= $1 and created_at < $2`,
    w,
  );

  // Spend in the window by purpose/provider/model (reservations included; split later).
  const spend = await db.query<SpendRowRaw>(
    `select purpose, provider, model, count(*)::int as calls,
            coalesce(sum(input_tokens), 0)::text as input_tokens, coalesce(sum(output_tokens), 0)::text as output_tokens,
            coalesce(sum(cost_usd), 0)::text as cost_usd
       from model_calls where created_at >= $1 and created_at < $2
      group by 1, 2, 3 order by sum(cost_usd) desc, 1, 2, 3`,
    w,
  );

  // Per run: model_calls.source_id is the upload whose run spent (a re-run of a
  // failed bank records under the re-upload, not the bank). The run's outcome
  // is its bank's status: the duplicate_of_id target, else itself.
  const runs = await db.query<RunRow>(
    `with r as (
       select source_id,
              coalesce(sum(cost_usd) filter (where purpose <> '${R}'), 0)::text as recorded_usd,
              coalesce(sum(cost_usd) filter (where purpose = '${R}'), 0)::text as held_usd,
              (count(*) filter (where purpose = '${R}'))::int as held_count,
              array_agg(distinct purpose order by purpose) as purposes
         from model_calls where created_at >= $1 and created_at < $2
        group by source_id)
     select r.source_id, coalesce(s.duplicate_of_id, s.id) as bank_id, b.status::text as bank_status,
            r.recorded_usd, r.held_usd, r.held_count, r.purposes
       from r left join sources s on s.id = r.source_id
              left join sources b on b.id = coalesce(s.duplicate_of_id, s.id)`,
    w,
  );

  // Reservations still held, created in the window.
  const held = await db.query<HeldRow>(
    `select m.source_id, b.status::text as bank_status, m.created_at, m.cost_usd::text as cost_usd
       from model_calls m left join sources s on s.id = m.source_id
            left join sources b on b.id = coalesce(s.duplicate_of_id, s.id)
      where m.purpose = '${R}' and m.created_at >= $1 and m.created_at < $2
      order by m.created_at`,
    w,
  );

  // Month to date, the way the ceiling counts it (worker/limits/spend-db.ts monthSpendUsd).
  const month = await db.query<MonthRow>(
    `select coalesce(sum(cost_usd) filter (where purpose <> '${R}'), 0)::text as recorded_usd,
            coalesce(sum(cost_usd) filter (where purpose = '${R}'), 0)::text as held_usd
       from model_calls where created_at >= $1`,
    [monthStart],
  );

  // Failed and refused sources whose status changed in the window, by message.
  const failures = await db.query<FailureRow>(
    `select status::text as status, error, count(*)::int as sources
       from sources where status in ('failed', 'refused') and updated_at >= $1 and updated_at < $2
      group by 1, 2 order by 3 desc, 1, 2`,
    w,
  );

  // Not windowed: anything sitting in uploaded/processing now for too long.
  const stuck = await db.query<StuckRow>(
    `select id, status::text as status, updated_at from sources
      where status in ('uploaded', 'processing') and updated_at < $1::timestamptz - make_interval(mins => ${STUCK_AFTER_MINUTES})
      order by updated_at limit 20`,
    [to],
  );

  const flush = await db.query<FlushRow>(
    `select (count(*) filter (where created_at - finished_at > make_interval(secs => ${LATE_FLUSH_SECONDS})))::int as late,
            round(max(extract(epoch from created_at - finished_at)))::int as max_lag_seconds
       from sessions where finished_at >= $1 and finished_at < $2`,
    w,
  );

  return {
    quizzes: quizzes.rows,
    quizUsers: quizUsers.rows[0]?.n ?? 0,
    uploads: uploads.rows,
    uploaders: uploaders.rows[0]?.n ?? 0,
    spend: spend.rows,
    runs: runs.rows,
    held: held.rows,
    month: month.rows[0] ?? { recorded_usd: "0", held_usd: "0" },
    failures: failures.rows,
    stuck: stuck.rows,
    flush: flush.rows[0] ?? { late: 0, max_lag_seconds: null },
  };
}

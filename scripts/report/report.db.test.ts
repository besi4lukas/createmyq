/**
 * STM-27: the report's SQL against PGlite (Postgres in WASM, the repo's
 * migrations applied), then the pure build and the text. No network.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCANNED_PDF } from "../../worker/extract/result";
import { TOO_THIN } from "../../worker/workflows/rules";
import { loadReport, type Queryable, type RawReport } from "./queries";
import { buildReport, formatReport, type Report } from "./report";
import { parseWindow } from "./window";

const NOW = new Date("2026-10-08T15:30:00Z");
const MONTH = new Date("2026-10-01T00:00:00Z");
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const CAT = "44444444-4444-4444-8444-444444444444";
const S = (c: string) => `aaaaaaaa-0000-4000-8000-0000000000${c}`;

let pg: PGlite;
let raw: RawReport;
let report: Report;

async function seed(db: PGlite) {
  await db.exec(`
    insert into invites (email) values ('u1@test.dev'), ('u2@test.dev');
    insert into users (id, email) values ('${U1}', 'u1@test.dev'), ('${U2}', 'u2@test.dev');
    insert into categories (id, slug, name, niche) values ('${CAT}', 'system-design', 'System design', 'se');
    insert into sessions (user_id, idempotency_key, kind, category_id, mode, difficulty, question_count, score, started_at, finished_at, created_at) values
      ('${U1}', 'k1', 'category', '${CAT}', 'practice', 'beginner', 5, 4, '2026-10-06T10:00Z', '2026-10-06T10:05Z', '2026-10-06T10:05:01Z'),
      ('${U1}', 'k2', 'category', '${CAT}', 'exam', 'advanced', 10, 5, '2026-10-07T10:00Z', '2026-10-07T10:09Z', '2026-10-07T10:14Z'),
      ('${U2}', 'k3', 'category', '${CAT}', 'practice', 'beginner', 5, 2, '2026-10-08T09:00Z', '2026-10-08T09:04Z', '2026-10-08T09:04:01Z'),
      ('${U1}', 'k4', 'review', null, 'practice', null, 4, 3, '2026-10-08T11:00Z', '2026-10-08T11:03Z', '2026-10-08T11:03:01Z'),
      ('${U2}', 'k0', 'category', '${CAT}', 'practice', 'beginner', 5, 5, '2026-10-01T09:00Z', '2026-10-01T09:04Z', '2026-10-01T09:04:01Z');
    insert into sources (id, owner_id, kind, content_hash, status, duplicate_of_id, error, created_at, updated_at) values
      ('${S("0a")}', '${U1}', 'pdf', 'h-a', 'ready', null, null, '2026-10-06T08:00Z', '2026-10-06T08:02Z'),
      ('${S("0b")}', '${U2}', 'pdf', null, 'duplicate', '${S("0a")}', null, '2026-10-07T08:00Z', '2026-10-07T08:00Z'),
      ('${S("0c")}', '${U1}', 'pdf', 'h-c', 'refused', null, 'This looks like cooking. CreateMyQ only covers software engineering right now.', '2026-10-06T09:00Z', '2026-10-06T09:01Z'),
      ('${S("0d")}', '${U2}', 'pdf', null, 'duplicate', '${S("0c")}', null, '2026-10-07T09:00Z', '2026-10-07T09:00Z'),
      ('${S("0e")}', '${U1}', 'pdf', 'h-e', 'failed', null, '${TOO_THIN}', '2026-10-06T12:00Z', '2026-10-07T12:30Z'),
      ('${S("0f")}', '${U2}', 'pdf', null, 'duplicate', '${S("0e")}', null, '2026-10-07T12:00Z', '2026-10-07T12:00Z'),
      ('${S("10")}', '${U2}', 'pdf', null, 'failed', null, '${SCANNED_PDF}', '2026-10-08T07:00Z', '2026-10-08T07:00Z'),
      ('${S("11")}', '${U1}', 'pdf', 'h-h', 'processing', null, null, '2026-10-08T13:00Z', '2026-10-08T13:00Z'),
      ('${S("12")}', '${U1}', 'pdf', null, 'uploaded', null, null, '2026-10-01T09:00Z', '2026-10-01T09:00Z');
    insert into model_calls (source_id, user_id, purpose, provider, model, input_tokens, output_tokens, cost_usd, created_at) values
      ('${S("0a")}', '${U1}', 'classify', 'workers-ai', 'qwen', 900, 0, 0.000040, '2026-10-06T08:01Z'),
      ('${S("0a")}', '${U1}', 'generate', 'anthropic', 'claude-sonnet-5-5', 14000, 7800, 0.100000, '2026-10-06T08:01Z'),
      ('${S("0a")}', '${U1}', 'grade', 'anthropic', 'claude-haiku-4-5', 9000, 1500, 0.015000, '2026-10-06T08:01Z'),
      ('${S("0a")}', '${U1}', 'embed', 'workers-ai', 'qwen', 3000, 0, 0.000020, '2026-10-06T08:01Z'),
      ('${S("0a")}', '${U1}', 'tag', 'anthropic', 'claude-haiku-4-5', 4000, 600, 0.006000, '2026-10-06T08:02Z'),
      ('${S("0c")}', '${U1}', 'classify', 'workers-ai', 'qwen', 800, 0, 0.000037, '2026-10-06T09:01Z'),
      ('${S("0e")}', '${U1}', 'generate', 'anthropic', 'claude-sonnet-5-5', 6000, 3000, 0.050000, '2026-10-06T12:10Z'),
      ('${S("0e")}', '${U1}', 'reservation', 'createmyq', 'estimate', 0, 0, 0.200000, '2026-10-06T12:01Z'),
      ('${S("0f")}', '${U2}', 'reservation', 'createmyq', 'estimate', 0, 0, 0.200000, '2026-10-07T12:01Z'),
      ('${S("11")}', '${U1}', 'reservation', 'createmyq', 'estimate', 0, 0, 0.200000, '2026-10-08T13:00Z'),
      (null, null, 'generate', 'anthropic', 'claude-sonnet-5-5', 1, 1, 0.500000, '2026-10-02T10:00Z'),
      (null, null, 'generate', 'anthropic', 'claude-sonnet-5-5', 1, 1, 1.000000, '2026-09-30T10:00Z');
  `);
}

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await migrate(drizzle({ client: pg }), { migrationsFolder: "drizzle" });
  await seed(pg);
  const window = { from: new Date("2026-10-05T00:00:00Z"), to: NOW, timeZone: "UTC", label: "this week (Monday 00:00 to now)" };
  expect(parseWindow({ week: true }, NOW)).toEqual(window);
  raw = await loadReport(pg as unknown as Queryable, window.from, window.to, MONTH);
  report = buildReport(raw, window, MONTH, 15);
}, 60_000);
afterAll(() => pg.close());

describe("report against SQL", () => {
  it("counts quizzes by kind and distinct users, finished in the window only", () => {
    expect(report.quizzes).toEqual({
      total: 4,
      users: 2,
      byKind: [
        { kind: "category", quizzes: 3, users: 2, questions: 20, correct: 11 },
        { kind: "review", quizzes: 1, users: 1, questions: 4, correct: 3 },
      ],
    });
    expect(report.health.lateFlushes).toBe(1);
    expect(report.health.maxFlushLagSeconds).toBe(300);
  });

  it("counts uploads and cache hits (a duplicate that spent is a re-run, not a hit)", () => {
    expect(report.uploads).toEqual({
      total: 8,
      uploaders: 2,
      byStatus: { duplicate: 3, failed: 2, processing: 1, ready: 1, refused: 1 },
      fingerprinted: 7,
      cacheHits: 2,
      cacheHitRate: 2 / 7,
      cacheHitsByBankStatus: { ready: 1, refused: 1 },
      reRuns: 1,
    });
  });

  it("splits recorded spend from held reservations", () => {
    const s = report.spend;
    expect(s.recordedUsd).toBe(0.171097);
    expect(s.held).toEqual({ count: 3, usd: 0.6 });
    expect(s.totalUsd).toBe(0.771097);
    expect(s.byPurpose.map((p) => [p.purpose, p.calls, p.usd])).toEqual([
      ["generate", 2, 0.15],
      ["grade", 1, 0.015],
      ["tag", 1, 0.006],
      ["classify", 2, 0.000077],
      ["embed", 1, 0.00002],
    ]);
    expect(s.byModel.map((m) => [m.model, m.calls, m.usd])).toEqual([
      ["claude-sonnet-5-5", 2, 0.15],
      ["claude-haiku-4-5", 2, 0.021],
      ["qwen", 3, 0.000097],
    ]);
    expect(s.byOutcome).toEqual([
      { outcome: "ready", runs: 1, recordedUsd: 0.12106, heldUsd: 0 },
      { outcome: "refused", runs: 1, recordedUsd: 0.000037, heldUsd: 0 },
      { outcome: "failed", runs: 2, recordedUsd: 0.05, heldUsd: 0.4 },
      { outcome: "in progress", runs: 1, recordedUsd: 0, heldUsd: 0.2 },
    ]);
    expect(s.readyBanks).toBe(1);
    expect(s.costPerReadyBankUsd).toBe(0.12106);
    expect(s.top[0]).toEqual({ sourceId: S("0e"), bankId: S("0e"), outcome: "failed", recordedUsd: 0.05, heldUsd: 0.2, purposes: ["generate"] });
    expect(s.top.find((t) => t.sourceId === S("0f"))?.bankId).toBe(S("0e"));
    expect(s.heldReservations.map((h) => [h.sourceId, h.outcome])).toEqual([
      [S("0e"), "failed"],
      [S("0f"), "failed"],
      [S("11"), "in progress"],
    ]);
  });

  it("totals the month the way the ceiling does", () => {
    expect(report.month).toMatchObject({ recordedUsd: 0.671097, heldUsd: 0.6, totalUsd: 1.271097, ceilingUsd: 15, remainingUsd: 13.728903 });
  });

  it("reports failures by code and stuck sources", () => {
    expect(report.health.failures.map((f) => [f.status, f.code, f.sources])).toEqual([
      ["failed", "extract", 1],
      ["failed", "too_thin", 1],
      ["refused", "off_topic", 1],
    ]);
    expect(report.health.stuck.map((s) => s.sourceId)).toEqual([S("12"), S("11")]);
  });

  it("prints every section with its definition", () => {
    const text = formatReport(report, "ep-test / neondb");
    expect(text).toContain("Window: 2026-10-05 00:00 UTC → 2026-10-08 15:30 UTC");
    expect(text).toContain("QUIZZES TAKEN  4 by 2 users");
    expect(text).toContain("cache hit rate: 28.6% (2 of 7 fingerprinted uploads); hits by bank: ready 1, refused 1");
    expect(text).toContain("SPEND  $0.7711 = $0.1711 recorded + $0.6000 held in 3 reservations");
    expect(text).toContain("Cost per ready bank: $0.1211 (1 bank; target < $0.15)");
    expect(text).toContain("$1.2711 of the $15.0000 ceiling (8.5%), $13.7289 left");
    expect(text).toContain("session_flush_STUCK");
  });

  it("an empty window prints zeros, not errors", () => {
    const empty = buildReport(
      { ...raw, quizzes: [], quizUsers: 0, uploads: [], uploaders: 0, spend: [], runs: [], held: [], failures: [], stuck: [], flush: { late: 0, max_lag_seconds: null } },
      { from: MONTH, to: NOW, timeZone: "UTC", label: "x" },
      MONTH,
      0,
    );
    expect(empty.uploads.cacheHitRate).toBeNull();
    expect(empty.month.percentOfCeiling).toBeNull();
    expect(formatReport(empty, "t")).toContain("cache hit rate: n/a (0 of 0 fingerprinted uploads)");
  });
});

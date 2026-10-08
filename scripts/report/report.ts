/**
 * STM-27: the cost report as data, and as text. Pure: built from the raw rows
 * (queries.ts) and the window, so it is unit-tested without a database.
 *
 * Definitions (also printed under each section):
 * - Quizzes taken: finished quizzes (`sessions` rows) with finished_at in the window.
 * - Uploads: `sources` rows created in the window. Every upload is its own row,
 *   a duplicate too.
 * - Cache hit: an upload whose fingerprint matched an existing bank
 *   (status `duplicate`) and that called no model itself. A duplicate with
 *   model_calls of its own re-ran a failed bank: a re-run, not a hit.
 *   Cache hit rate = hits ÷ uploads that reached the fingerprint step.
 * - Spend: `model_calls` rows created in the window. Recorded = real calls.
 *   Held = `reservation` rows ($0.20 each) still in the table: a run in
 *   progress, or one whose cost is unknown or that failed after reserving.
 *   They count against the ceiling, so they are shown, never hidden, and never
 *   mixed into recorded spend.
 * - A run = one source_id in model_calls. Its outcome = its bank's status.
 */
import { assertNever } from "../../worker/lib/assert";
import { RESERVATION, SPEND_CEILING_MESSAGE } from "../../worker/limits/spend";
import { GENERATION_FAILED, GENERATION_OFF, TOO_MUCH_TEXT, TOO_THIN } from "../../worker/workflows/rules";
import { LATE_FLUSH_SECONDS, STUCK_AFTER_MINUTES, type RawReport } from "./queries";
import type { ReportWindow } from "./window";

export type Outcome = "ready" | "refused" | "failed" | "in progress" | "unknown";

export type Report = {
  window: { from: string; to: string; timeZone: string; label: string };
  quizzes: {
    total: number;
    users: number;
    byKind: { kind: string; quizzes: number; users: number; questions: number; correct: number }[];
  };
  uploads: {
    total: number;
    uploaders: number;
    byStatus: Record<string, number>;
    fingerprinted: number;
    cacheHits: number;
    cacheHitRate: number | null;
    cacheHitsByBankStatus: Record<string, number>;
    reRuns: number;
  };
  spend: {
    recordedUsd: number;
    held: { count: number; usd: number };
    totalUsd: number;
    byPurpose: { purpose: string; calls: number; inputTokens: number; outputTokens: number; usd: number }[];
    byModel: { provider: string; model: string; calls: number; usd: number }[];
    runs: number;
    byOutcome: { outcome: Outcome; runs: number; recordedUsd: number; heldUsd: number }[];
    readyBanks: number;
    costPerReadyBankUsd: number | null;
    top: { sourceId: string | null; bankId: string | null; outcome: Outcome; recordedUsd: number; heldUsd: number; purposes: string[] }[];
    heldReservations: { sourceId: string | null; outcome: Outcome; createdAt: string; usd: number }[];
  };
  month: { from: string; recordedUsd: number; heldUsd: number; totalUsd: number; ceilingUsd: number; percentOfCeiling: number | null; remainingUsd: number };
  health: {
    failures: { status: string; code: string; message: string | null; sources: number }[];
    stuck: { sourceId: string; status: string; since: string }[];
    lateFlushes: number;
    maxFlushLagSeconds: number | null;
  };
};

const usd = (s: string | number) => Number(Number(s).toFixed(6));
const sum = (xs: number[]) => usd(xs.reduce((a, b) => a + b, 0));

/** The run's outcome, from its bank's status. */
export function outcomeOf(bankStatus: string | null): Outcome {
  switch (bankStatus) {
    case "ready":
    case "refused":
    case "failed":
      return bankStatus;
    case "uploaded":
    case "processing":
      return "in progress";
    default:
      return "unknown"; // source deleted (model_calls.source_id set null) or not a bank status
  }
}

/** A short code for a stored user-facing message (sources.error). */
export function errorCode(status: string, message: string | null): string {
  if (status === "refused") return "off_topic";
  switch (message) {
    case GENERATION_OFF:
      return "generation_off";
    case SPEND_CEILING_MESSAGE:
      return "spend_ceiling";
    case TOO_THIN:
      return "too_thin";
    case TOO_MUCH_TEXT:
      return "too_much_text";
    case GENERATION_FAILED:
      return "step_failed";
    case null:
      return "no_message";
    default:
      return "extract"; // the extractors' own messages (unreadable, scanned, no captions, …)
  }
}

export function buildReport(raw: RawReport, window: ReportWindow, monthStart: Date, ceilingUsd: number, top = 5): Report {
  const byStatus: Record<string, number> = {};
  const cacheHitsByBankStatus: Record<string, number> = {};
  let fingerprinted = 0;
  let cacheHits = 0;
  let reRuns = 0;
  for (const u of raw.uploads) {
    byStatus[u.status] = (byStatus[u.status] ?? 0) + u.uploads;
    if (u.fingerprinted) fingerprinted += u.uploads;
    if (u.status !== "duplicate") continue;
    if (u.spent) {
      reRuns += u.uploads;
    } else {
      cacheHits += u.uploads;
      const key = u.bank_status ?? "unknown";
      cacheHitsByBankStatus[key] = (cacheHitsByBankStatus[key] ?? 0) + u.uploads;
    }
  }

  const reservations = raw.spend.filter((s) => s.purpose === RESERVATION.purpose);
  const real = raw.spend.filter((s) => s.purpose !== RESERVATION.purpose);
  const recordedUsd = sum(real.map((s) => usd(s.cost_usd)));
  const held = { count: reservations.reduce((n, s) => n + s.calls, 0), usd: sum(reservations.map((s) => usd(s.cost_usd))) };

  const purposes = new Map<string, Report["spend"]["byPurpose"][number]>();
  const models = new Map<string, Report["spend"]["byModel"][number]>();
  for (const s of real) {
    const p = purposes.get(s.purpose) ?? { purpose: s.purpose, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    p.calls += s.calls;
    p.inputTokens += Number(s.input_tokens);
    p.outputTokens += Number(s.output_tokens);
    p.usd = usd(p.usd + usd(s.cost_usd));
    purposes.set(s.purpose, p);
    const key = `${s.provider}\u0000${s.model}`;
    const m = models.get(key) ?? { provider: s.provider, model: s.model, calls: 0, usd: 0 };
    m.calls += s.calls;
    m.usd = usd(m.usd + usd(s.cost_usd));
    models.set(key, m);
  }
  const byUsd = <T extends { usd: number }>(a: T, b: T) => b.usd - a.usd;

  const runs = raw.runs.map((r) => ({
    sourceId: r.source_id,
    bankId: r.bank_id,
    outcome: outcomeOf(r.bank_status),
    recordedUsd: usd(r.recorded_usd),
    heldUsd: usd(r.held_usd),
    purposes: r.purposes.filter((p) => p !== RESERVATION.purpose),
  }));
  const outcomes: Outcome[] = ["ready", "refused", "failed", "in progress", "unknown"];
  const byOutcome = outcomes
    .map((outcome) => {
      const rs = runs.filter((r) => r.outcome === outcome);
      return { outcome, runs: rs.length, recordedUsd: sum(rs.map((r) => r.recordedUsd)), heldUsd: sum(rs.map((r) => r.heldUsd)) };
    })
    .filter((o) => o.runs > 0);
  const readyRuns = runs.filter((r) => r.outcome === "ready");
  const readyBanks = new Set(readyRuns.map((r) => r.bankId)).size;
  const readyUsd = sum(readyRuns.map((r) => r.recordedUsd + r.heldUsd));

  const monthRecorded = usd(raw.month.recorded_usd);
  const monthHeld = usd(raw.month.held_usd);
  const monthTotal = usd(monthRecorded + monthHeld);

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString(), timeZone: window.timeZone, label: window.label },
    quizzes: {
      total: raw.quizzes.reduce((n, q) => n + q.quizzes, 0),
      users: raw.quizUsers,
      byKind: raw.quizzes.map((q) => ({ ...q })),
    },
    uploads: {
      total: raw.uploads.reduce((n, u) => n + u.uploads, 0),
      uploaders: raw.uploaders,
      byStatus,
      fingerprinted,
      cacheHits,
      cacheHitRate: fingerprinted > 0 ? cacheHits / fingerprinted : null,
      cacheHitsByBankStatus,
      reRuns,
    },
    spend: {
      recordedUsd,
      held,
      totalUsd: usd(recordedUsd + held.usd),
      byPurpose: [...purposes.values()].sort(byUsd),
      byModel: [...models.values()].sort(byUsd),
      runs: runs.length,
      byOutcome,
      readyBanks,
      costPerReadyBankUsd: readyBanks > 0 ? usd(readyUsd / readyBanks) : null,
      top: [...runs].sort((a, b) => b.recordedUsd + b.heldUsd - (a.recordedUsd + a.heldUsd)).slice(0, top),
      heldReservations: raw.held.map((h) => ({
        sourceId: h.source_id,
        outcome: outcomeOf(h.bank_status),
        createdAt: new Date(h.created_at).toISOString(),
        usd: usd(h.cost_usd),
      })),
    },
    month: {
      from: monthStart.toISOString(),
      recordedUsd: monthRecorded,
      heldUsd: monthHeld,
      totalUsd: monthTotal,
      ceilingUsd,
      percentOfCeiling: ceilingUsd > 0 ? monthTotal / ceilingUsd : null,
      remainingUsd: usd(Math.max(0, ceilingUsd - monthTotal)),
    },
    health: {
      failures: raw.failures.map((f) => ({ status: f.status, code: errorCode(f.status, f.error), message: f.error, sources: f.sources })),
      stuck: raw.stuck.map((s) => ({ sourceId: s.id, status: s.status, since: new Date(s.updated_at).toISOString() })),
      lateFlushes: raw.flush.late,
      maxFlushLagSeconds: raw.flush.max_lag_seconds,
    },
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Dollars to 4 places; sub-cent-hundredth amounts (embeddings, a classify call) to 6, so they don't read as $0. */
export const money = (n: number) => `$${n > 0 && n < 0.0001 ? n.toFixed(6) : n.toFixed(4)}`;
const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const int = (n: number) => n.toLocaleString("en-US");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A timestamp in the report's zone, e.g. "2026-10-05 00:00 UTC". */
export function when(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

/** Fixed-width table: numeric columns (counts, money, percentages) right-aligned, text left. */
export function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const numeric = head.map((_, i) => rows.length > 0 && rows.every((r) => /^(\$?[\d,.]+%?|n\/a)$/.test(r[i] ?? "")));
  const line = (r: string[]) =>
    "  " + r.map((c, i) => (numeric[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)];
}

function outcomeNote(o: Outcome): string {
  switch (o) {
    case "ready":
      return "bank ready";
    case "refused":
      return "off-topic, refused by the gate";
    case "failed":
      return "run failed";
    case "in progress":
      return "run still in progress";
    case "unknown":
      return "source row gone";
    default:
      return assertNever(o);
  }
}

export function formatReport(r: Report, target: string): string {
  const tz = r.window.timeZone;
  const out: string[] = [];
  out.push(`CreateMyQ report: ${r.window.label}`);
  out.push(`Window: ${when(r.window.from, tz)} → ${when(r.window.to, tz)} (from inclusive, to exclusive)`);
  out.push(`Database: ${target}, read-only`);
  out.push("");

  out.push(`QUIZZES TAKEN  ${int(r.quizzes.total)} by ${int(r.quizzes.users)} user${r.quizzes.users === 1 ? "" : "s"}`);
  if (r.quizzes.byKind.length > 0) {
    out.push(
      ...table(
        ["kind", "quizzes", "users", "questions", "correct"],
        r.quizzes.byKind.map((q) => [q.kind, int(q.quizzes), int(q.users), int(q.questions), q.questions ? pct(q.correct / q.questions) : "n/a"]),
      ),
    );
  }
  out.push("  = finished quizzes (sessions rows) with finished_at in the window.");
  out.push("");

  const u = r.uploads;
  out.push(`UPLOADS AND CACHE  ${int(u.total)} upload${u.total === 1 ? "" : "s"} by ${int(u.uploaders)} user${u.uploaders === 1 ? "" : "s"}`);
  if (u.total > 0) {
    out.push(`  by status: ${Object.entries(u.byStatus).map(([s, n]) => `${s} ${n}`).join(", ")}`);
  }
  out.push(
    `  cache hit rate: ${pct(u.cacheHitRate)} (${u.cacheHits} of ${u.fingerprinted} fingerprinted upload${u.fingerprinted === 1 ? "" : "s"})` +
      (u.cacheHits > 0 ? `; hits by bank: ${Object.entries(u.cacheHitsByBankStatus).map(([s, n]) => `${s} ${n}`).join(", ")}` : ""),
  );
  if (u.reRuns > 0) out.push(`  re-runs of a failed bank: ${u.reRuns} (duplicates that called models; not hits)`);
  out.push("  = sources rows created in the window. Cache hit: the fingerprint matched an existing bank (status duplicate)");
  out.push("    and the upload called no model. Rate = hits ÷ uploads that reached the fingerprint step.");
  out.push("");

  const s = r.spend;
  out.push(`SPEND  ${money(s.totalUsd)} = ${money(s.recordedUsd)} recorded + ${money(s.held.usd)} held in ${s.held.count} reservation${s.held.count === 1 ? "" : "s"}`);
  if (s.byPurpose.length > 0) {
    out.push("  By purpose (recorded):");
    out.push(...table(["purpose", "calls", "in tokens", "out tokens", "cost"], s.byPurpose.map((p) => [p.purpose, int(p.calls), int(p.inputTokens), int(p.outputTokens), money(p.usd)])));
    out.push("  By model (recorded):");
    out.push(...table(["provider / model", "calls", "cost"], s.byModel.map((m) => [`${m.provider} / ${m.model}`, int(m.calls), money(m.usd)])));
  }
  if (s.runs > 0) {
    out.push(`  Runs that spent: ${s.runs}`);
    out.push(...table(["outcome", "runs", "recorded", "held"], s.byOutcome.map((o) => [o.outcome, int(o.runs), money(o.recordedUsd), money(o.heldUsd)])));
    out.push(
      `  Cost per ready bank: ${s.costPerReadyBankUsd === null ? "n/a (no run in the window ended ready)" : `${money(s.costPerReadyBankUsd)} (${s.readyBanks} bank${s.readyBanks === 1 ? "" : "s"}; target < $0.15)`}`,
    );
    out.push(`  Top ${s.top.length} by cost (source → bank):`);
    out.push(
      ...table(
        ["source", "bank", "outcome", "cost", "purposes"],
        s.top.map((t) => [t.sourceId ?? "(deleted)", t.bankId === t.sourceId ? "same" : (t.bankId ?? "-"), t.outcome, money(t.recordedUsd + t.heldUsd), t.purposes.join(",")]),
      ),
    );
  }
  if (s.heldReservations.length > 0) {
    out.push("  Held reservations (counted against the ceiling until released):");
    out.push(
      ...table(
        ["source", "since", "amount", "why held"],
        s.heldReservations.map((h) => [h.sourceId ?? "(deleted)", when(h.createdAt, tz), money(h.usd), outcomeNote(h.outcome) + (h.outcome === "ready" || h.outcome === "refused" ? ": a cost was unknown (a retried step)" : "")]),
      ),
    );
  }
  out.push("  = model_calls rows created in the window. Recorded = real calls. Held = $0.20 reservation rows not");
  out.push("    released: a run in progress, a cost that was unknown, or a run that failed after reserving.");
  out.push("");

  const m = r.month;
  out.push(
    `MONTH TO DATE (since ${when(m.from, "UTC")})  ${money(m.totalUsd)} of the ${money(m.ceilingUsd)} ceiling (${pct(m.percentOfCeiling)}), ${money(m.remainingUsd)} left`,
  );
  out.push(`  = ${money(m.recordedUsd)} recorded + ${money(m.heldUsd)} held; the ceiling counts both (UTC calendar month).`);
  out.push("");

  const h = r.health;
  out.push("HEALTH");
  if (h.failures.length === 0) out.push("  failed or refused sources in the window: none");
  else {
    out.push("  Failed or refused sources (status changed in the window):");
    out.push(...table(["status", "code", "sources", "message"], h.failures.map((f) => [f.status, f.code, int(f.sources), clip(f.message ?? "", 64)])));
  }
  out.push(
    h.stuck.length === 0
      ? `  stuck sources (uploaded/processing for > ${STUCK_AFTER_MINUTES} min): none`
      : `  stuck sources (uploaded/processing for > ${STUCK_AFTER_MINUTES} min): ${h.stuck.map((x) => `${x.sourceId} (${x.status} since ${when(x.since, tz)})`).join("; ")}`,
  );
  out.push(
    `  late flushes (session row > ${LATE_FLUSH_SECONDS} s after finish, so the alarm retry landed it): ${h.lateFlushes}` +
      (h.maxFlushLagSeconds !== null ? `; max lag ${h.maxFlushLagSeconds} s` : ""),
  );
  out.push("  unflushed quizzes live only in Durable Objects: Workers Logs, search session_flush_STUCK / session_flush_failed.");
  return out.join("\n");
}

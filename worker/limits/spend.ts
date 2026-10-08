/**
 * STM-24: the global spend ceiling, as pure rules. Spend lives in Postgres
 * (`model_calls`), because it is shared by every user (spend-db.ts does the I/O).
 *
 * How a run spends:
 *   1. Before its first model call, the Workflow reserves RESERVE_PER_RUN_USD:
 *      one `model_calls` row (purpose "reservation"), written only if this
 *      month's total plus the reservation stays within the ceiling. The check
 *      and the insert run under one advisory lock, so concurrent runs can't
 *      all squeeze under the ceiling together.
 *   2. After the last model call, the reservation is replaced by one row per
 *      call (or per chunk) with the real tokens and cost. If some cost is
 *      unknown (a failed attempt that may have been billed), the reservation is
 *      kept as well: over-counting is safe, under-counting is not.
 *   3. A run that fails after reserving keeps its reservation.
 *
 * So the month's total (real rows + open reservations) never passes the
 * ceiling by more than one run's cost beyond its reservation, which is the
 * rare pathological retry case.
 */

/** Dollars per calendar month (UTC), unless SPEND_CEILING_USD says otherwise. CLAUDE.md: < $15/month. */
export const DEFAULT_SPEND_CEILING_USD = 15;

/**
 * What a run is assumed to cost until it has finished calling models.
 * Measured runs cost $0.115–0.137 ($0.157 with a retried grade, STM-19).
 */
export const RESERVE_PER_RUN_USD = 0.2;

/** Shown when the ceiling stops an upload or a queued run (sources.error, API error). */
export const SPEND_CEILING_MESSAGE =
  "New quizzes from your own files are paused until next month: CreateMyQ has reached its monthly spending limit. Built-in categories still work.";

/** SPEND_CEILING_USD as a number ≥ 0; anything else is the default. */
export function parseSpendCeiling(value: string | undefined): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_SPEND_CEILING_USD;
}

/** 00:00 UTC on the 1st of `now`'s month: spend is summed from here. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** May a run that needs `reserveUsd` start, with `spentUsd` already spent or reserved this month? */
export function ceilingAllows(spentUsd: number, ceilingUsd: number, reserveUsd = RESERVE_PER_RUN_USD): boolean {
  // Cents-level rounding, so 14.8 + 0.2 counts as exactly 15.
  return Math.round((spentUsd + reserveUsd) * 1e6) <= Math.round(ceilingUsd * 1e6);
}

/**
 * A UUID made from `parts` (SHA-256, version/variant bits set). Spend rows get
 * ids from the run's instance id, so a step that re-runs after committing
 * writes the same rows again and ON CONFLICT drops them.
 */
export async function stableUuid(...parts: string[]): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8 (custom)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

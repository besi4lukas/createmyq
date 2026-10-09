/**
 * STM-24 at intake, shared by every way a source comes in (PDF upload, link):
 * the user's daily generation cap (in their UserSession) and the global
 * monthly spend ceiling (Postgres). The answers are HTTP-shaped on purpose:
 * every intake route refuses with the same status, code and message.
 */
import type { Context } from "hono";
import type { AppEnv } from "../auth/session";
import type { Db } from "../db/client";
import { apiError } from "../http";
import { assertNever } from "../lib/assert";
import { capMessage, type CapWindow } from "./daily-cap";
import { SPEND_CEILING_MESSAGE, ceilingAllows, parseSpendCeiling } from "./spend";
import { monthSpendUsd } from "./spend-db";

export const userSession = (c: Context<AppEnv>) =>
  c.env.USER_SESSION.get(c.env.USER_SESSION.idFromName(c.var.user.id));

export const dailyCapHit = (c: Context, limit: number, window: CapWindow) =>
  apiError(c, 429, capMessage(window, Date.now()), {
    code: "daily_cap",
    limit,
    resetAt: new Date(window.resetAt).toISOString(),
    timeZone: window.timeZone,
  });

export const ceilingHit = (c: Context) => apiError(c, 503, SPEND_CEILING_MESSAGE, { code: "spend_ceiling" });

/**
 * Is there room under this month's spend ceiling for one more run? A fast,
 * read-only answer for the user; the Workflow's reservation is the real gate.
 */
export async function underCeiling(c: Context<AppEnv>, db: Pick<Db, "select"> = c.var.db, now = new Date()): Promise<boolean> {
  return ceilingAllows(await monthSpendUsd(db, now), parseSpendCeiling(c.env.SPEND_CEILING_USD));
}

export type Refusal = { code: "spend_ceiling" } | { code: "daily_cap"; limit: number; window: CapWindow };

/**
 * For a new source: room under the spend ceiling, then a slot in the user's
 * daily cap (counted here, by source id, so a retry counts once). Null admits it.
 * Runs inside recordSource's transaction (`tx`).
 */
export async function admitGeneration(
  c: Context<AppEnv>,
  tx: Pick<Db, "select">,
  sourceId: string,
  timeZone: string,
  now: Date,
): Promise<Refusal | null> {
  if (!(await underCeiling(c, tx, now))) return { code: "spend_ceiling" };
  const reserved = await userSession(c).reserveGeneration(sourceId, timeZone);
  if (!reserved.ok) return { code: "daily_cap", limit: reserved.limit, window: reserved.window };
  console.log(JSON.stringify({ event: "daily_cap_counted", sourceId, used: reserved.window.sourceIds.length, limit: reserved.limit }));
  return null;
}

export function refusalResponse(c: Context, refusal: Refusal) {
  switch (refusal.code) {
    case "spend_ceiling":
      return ceilingHit(c);
    case "daily_cap":
      return dailyCapHit(c, refusal.limit, refusal.window);
    default:
      return assertNever(refusal);
  }
}

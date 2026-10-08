/**
 * STM-27: what did this week cost? One command, read-only.
 *
 *   npm run report                       # the last 7 days (rolling), UTC
 *   npm run report -- --week             # this week: Monday 00:00 → now
 *   npm run report -- --last-week        # the previous Monday → Monday
 *   npm run report -- --days 30
 *   npm run report -- --since 2026-10-01 [--until 2026-10-07]
 *   options: --tz America/Chicago (window boundaries; default UTC)
 *            --json (the report as JSON)  --top 5  --ceiling 15
 *
 * Target database, first one set wins (as db:seed):
 *   REPORT_DATABASE_URL     explicit override (e.g. a throwaway Neon branch)
 *   DATABASE_URL_UNPOOLED   shell, else .env.local
 *
 * Every query runs in one READ ONLY transaction that is rolled back: the
 * report never writes. Definitions are in scripts/report/report.ts and are
 * printed with the report.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { monthStart, parseSpendCeiling } from "../worker/limits/spend";
import { loadReport } from "./report/queries";
import { buildReport, formatReport } from "./report/report";
import { parseWindow } from "./report/window";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Which database, described without credentials (Neon endpoint id / database). */
function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.split(".")[0]} / ${u.pathname.slice(1) || "(default db)"}`;
  } catch {
    return "(unparseable connection string)";
  }
}

/** SPEND_CEILING_USD from wrangler.jsonc's vars, as the Worker parses it. */
function ceilingFromWrangler(): number {
  const text = existsSync("wrangler.jsonc") ? readFileSync("wrangler.jsonc", "utf8") : "";
  const m = /"SPEND_CEILING_USD"\s*:\s*"([^"]*)"/.exec(text);
  return parseSpendCeiling(m?.[1]);
}

async function main() {
  const { values } = parseArgs({
    options: {
      days: { type: "string" },
      week: { type: "boolean" },
      "last-week": { type: "boolean" },
      since: { type: "string" },
      until: { type: "string" },
      tz: { type: "string" },
      json: { type: "boolean", default: false },
      top: { type: "string", default: "5" },
      ceiling: { type: "string" },
    },
  });
  const now = new Date();
  let window;
  try {
    window = parseWindow(
      { days: values.days, week: values.week, lastWeek: values["last-week"], since: values.since, until: values.until, tz: values.tz },
      now,
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const top = Number(values.top);
  if (!Number.isInteger(top) || top < 1) fail("--top must be a whole number ≥ 1.");
  const ceilingUsd = values.ceiling !== undefined ? Number(values.ceiling) : ceilingFromWrangler();
  if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) fail("--ceiling must be a number ≥ 0.");

  // Shell variables win over .env.local, as in drizzle.config.ts and db:seed.
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const fromOverride = Boolean(process.env.REPORT_DATABASE_URL);
  const url = process.env.REPORT_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) fail("No database: set REPORT_DATABASE_URL or DATABASE_URL_UNPOOLED.");
  const target = `${describeTarget(url)} (from ${fromOverride ? "REPORT_DATABASE_URL" : "DATABASE_URL_UNPOOLED"})`;
  if (values.json) console.error(`Reading ${target}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  const month = monthStart(now);
  let raw;
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    raw = await loadReport(client, window.from, window.to, month);
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }

  const report = buildReport(raw, window, month, ceilingUsd, top);
  console.log(values.json ? JSON.stringify({ target, ...report }, null, 2) : formatReport(report, target));
}

main().catch((err: unknown) => {
  console.error(`Report failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

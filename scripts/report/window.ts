/**
 * STM-27: the report's time window, from the command line. Pure: `now` is an
 * argument. Boundaries are local midnights in `timeZone` (UTC unless --tz),
 * DST-safe via the daily cap's nextMidnight. A window is [from, to).
 */
import { nextMidnight, safeTimeZone } from "../../worker/limits/daily-cap";

export type ReportWindow = { from: Date; to: Date; timeZone: string; label: string };

export type WindowArgs = {
  days?: string;
  week?: boolean;
  lastWeek?: boolean;
  since?: string;
  until?: string;
  tz?: string;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function localDate(timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (t: number) => f.format(t); // YYYY-MM-DD
}

/** 00:00 (or the first instant after it, on a DST day) of `t`'s calendar day in `timeZone`. */
export function startOfDay(t: number, timeZone: string): number {
  const date = localDate(timeZone);
  const today = date(t);
  let y = t;
  while (date(y) === today) y -= HOUR;
  return nextMidnight(y, timeZone);
}

/** Start of the calendar day `ymd` (YYYY-MM-DD) in `timeZone`. */
export function startOfDate(ymd: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`Not a date (YYYY-MM-DD): ${ymd}`);
  const date = localDate(timeZone);
  let t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  if (Number.isNaN(t)) throw new Error(`Not a date: ${ymd}`);
  while (date(t) < ymd) t += 3 * HOUR;
  while (date(t) > ymd) t -= 3 * HOUR;
  if (date(t) !== ymd) throw new Error(`Not a date: ${ymd}`);
  return startOfDay(t, timeZone);
}

/** Monday 00:00 of the week containing `t`, in `timeZone`. */
export function startOfWeek(t: number, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(t);
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
  let start = startOfDay(t, timeZone);
  for (let i = 0; i < back; i++) start = startOfDay(start - 1, timeZone);
  return start;
}

/**
 * Exactly one of --days N, --week (Monday 00:00 → now), --last-week (the
 * previous Monday → Monday) or --since D [--until D] (whole days, --until
 * inclusive). Nothing → the last 7 days up to now.
 */
export function parseWindow(args: WindowArgs, now: Date): ReportWindow {
  const timeZone = args.tz ? safeTimeZone(args.tz) : "UTC";
  if (args.tz && timeZone === "UTC" && !/^(utc|etc\/utc|gmt|z)$/i.test(args.tz)) {
    throw new Error(`Unknown time zone: ${args.tz}`);
  }
  const picked = [args.days !== undefined, Boolean(args.week), Boolean(args.lastWeek), args.since !== undefined].filter(Boolean);
  if (picked.length > 1) throw new Error("Choose one of --days, --week, --last-week or --since.");
  if (args.until !== undefined && args.since === undefined) throw new Error("--until needs --since.");
  const t = now.getTime();

  if (args.week) {
    return { from: new Date(startOfWeek(t, timeZone)), to: now, timeZone, label: "this week (Monday 00:00 to now)" };
  }
  if (args.lastWeek) {
    const thisMonday = startOfWeek(t, timeZone);
    return {
      from: new Date(startOfWeek(thisMonday - 1, timeZone)),
      to: new Date(thisMonday),
      timeZone,
      label: "last week (Monday to Monday)",
    };
  }
  if (args.since !== undefined) {
    const from = startOfDate(args.since, timeZone);
    const to = args.until !== undefined ? nextMidnight(startOfDate(args.until, timeZone), timeZone) : t;
    if (to <= from) throw new Error("--until must not be before --since.");
    return {
      from: new Date(from),
      to: new Date(Math.min(to, t)),
      timeZone,
      label: args.until !== undefined ? `${args.since} to ${args.until} (whole days)` : `since ${args.since}`,
    };
  }
  const days = args.days === undefined ? 7 : Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("--days must be a whole number from 1 to 366.");
  return { from: new Date(t - days * DAY), to: now, timeZone, label: `the last ${days} day${days === 1 ? "" : "s"} (rolling, to now)` };
}

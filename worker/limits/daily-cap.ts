/**
 * STM-24: the daily generation cap, as pure rules. The UserSession Durable
 * Object stores the window (key `gen:window`) and calls these with the time.
 *
 * What counts: an upload that will start a generation run. It is counted at
 * POST /api/uploads/complete (atomically with the check, by sourceId, so a
 * retried complete counts once) and given back by the Workflow when the run
 * ends without reserving any spend (a duplicate of an existing bank, an
 * unreadable file, the kill switch or the spend ceiling). So, in effect, the
 * cap counts runs that reach the model.
 *
 * "Today" is the user's own calendar day, in the IANA time zone the browser
 * sends (UTC if it sends none or an invalid one). A window, once opened, keeps
 * its reset time: changing the time zone mid-day does not reset the count.
 */

/** CLAUDE.md "User-facing messages". The reset time is appended, never edited in. */
export const DAILY_CAP_MESSAGE = "You have hit today's limit. It resets at midnight.";

/** Runs per user per day, unless DAILY_GENERATION_CAP says otherwise. */
export const DEFAULT_DAILY_CAP = 3;

/** One user's current day. `sourceIds` are the uploads counted in it. */
export type CapWindow = { resetAt: number; timeZone: string; sourceIds: string[] };

export type Reservation =
  | { ok: true; window: CapWindow; counted: boolean }
  | { ok: false; window: CapWindow };

/** DAILY_GENERATION_CAP as a whole number ≥ 0; anything else is the default. */
export function parseDailyCap(value: string | undefined): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

/** `tz` if the runtime knows it as an IANA time zone, else "UTC". */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function dateIn(timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (t: number) => f.format(t);
}

/**
 * The first instant after `now` that is on a later calendar day in
 * `timeZone`: usually local midnight, or the first time after it when a DST
 * change skips midnight. A binary search, so DST and odd offsets need no
 * special cases (a local day is never longer than 26 hours).
 */
export function nextMidnight(now: number, timeZone: string): number {
  const date = dateIn(timeZone);
  const today = date(now);
  let lo = now; // still today
  let hi = now + 26 * 3_600_000; // a later day
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (date(mid) === today) lo = mid;
    else hi = mid;
  }
  return hi;
}

function isWindow(v: unknown): v is CapWindow {
  const w = v as CapWindow | undefined;
  return (
    typeof w === "object" &&
    w !== null &&
    typeof w.resetAt === "number" &&
    typeof w.timeZone === "string" &&
    Array.isArray(w.sourceIds) &&
    w.sourceIds.every((s) => typeof s === "string")
  );
}

/** The stored window while it lasts; after its reset time (or with none stored), a fresh one in `timeZone`. */
export function currentWindow(stored: unknown, now: number, timeZone: string): CapWindow {
  if (isWindow(stored) && now < stored.resetAt) return stored;
  const tz = safeTimeZone(timeZone);
  return { resetAt: nextMidnight(now, tz), timeZone: tz, sourceIds: [] };
}

/** Count `sourceId` in the window if there is room. Counting the same source twice is a no-op. */
export function reserveIn(window: CapWindow, sourceId: string, cap: number): Reservation {
  if (window.sourceIds.includes(sourceId)) return { ok: true, window, counted: false };
  if (window.sourceIds.length >= cap) return { ok: false, window };
  return { ok: true, window: { ...window, sourceIds: [...window.sourceIds, sourceId] }, counted: true };
}

/** Give `sourceId` back. A source from an earlier window is simply not there. */
export function refundIn(window: CapWindow, sourceId: string): { window: CapWindow; refunded: boolean } {
  if (!window.sourceIds.includes(sourceId)) return { window, refunded: false };
  return { window: { ...window, sourceIds: window.sourceIds.filter((s) => s !== sourceId) }, refunded: true };
}

/** "3 h 20 min", "45 min", "1 min". Rounded up, so it is never early. */
export function untilText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "CDT", "BST", "JST"… : whichever of the US and UK short names is not a bare "GMT±n", else that. */
function zoneName(at: number, timeZone: string): string {
  const name = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  const us = name("en-US");
  return /^(GMT|UTC)[+-]/.test(us) ? name("en-GB") : us;
}

/**
 * The cap message with the reset time appended, in the window's time zone:
 * "You have hit today's limit. It resets at midnight. That's in 5 h 42 min (Thu 8 Oct, 00:00 CDT)."
 */
export function capMessage(window: CapWindow, now: number): string {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: window.timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(window.resetAt);
  return `${DAILY_CAP_MESSAGE} That's in ${untilText(window.resetAt - now)} (${when} ${zoneName(window.resetAt, window.timeZone)}).`;
}

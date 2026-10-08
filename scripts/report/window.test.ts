import { describe, expect, it } from "vitest";
import { parseWindow, startOfDate, startOfDay, startOfWeek } from "./window";

// Thursday 8 Oct 2026, 15:30 UTC.
const NOW = new Date(Date.UTC(2026, 9, 8, 15, 30));
const iso = (t: number | Date) => new Date(t).toISOString();

describe("window", () => {
  it("defaults to the last 7 days, rolling, in UTC", () => {
    const w = parseWindow({}, NOW);
    expect([iso(w.from), iso(w.to), w.timeZone]).toEqual(["2026-10-01T15:30:00.000Z", "2026-10-08T15:30:00.000Z", "UTC"]);
  });

  it("--week is Monday 00:00 to now; --last-week the Monday before to this Monday", () => {
    expect(iso(parseWindow({ week: true }, NOW).from)).toBe("2026-10-05T00:00:00.000Z");
    const last = parseWindow({ lastWeek: true }, NOW);
    expect([iso(last.from), iso(last.to)]).toEqual(["2026-09-28T00:00:00.000Z", "2026-10-05T00:00:00.000Z"]);
  });

  it("uses local midnights with --tz", () => {
    // Chicago is UTC-5 in October.
    expect(iso(parseWindow({ week: true, tz: "America/Chicago" }, NOW).from)).toBe("2026-10-05T05:00:00.000Z");
    // A Monday 02:00 UTC is still Sunday in Chicago: the week started the Monday before.
    expect(iso(startOfWeek(Date.UTC(2026, 9, 5, 2), "America/Chicago"))).toBe("2026-09-28T05:00:00.000Z");
  });

  it("handles DST days", () => {
    // 1 Nov 2026: Chicago falls back, the day is 25 h long.
    expect(iso(startOfDay(Date.UTC(2026, 10, 2, 4, 30), "America/Chicago"))).toBe("2026-11-01T05:00:00.000Z");
    expect(iso(startOfDate("2026-11-02", "America/Chicago"))).toBe("2026-11-02T06:00:00.000Z");
  });

  it("--since/--until take whole days, --until inclusive, never past now", () => {
    const w = parseWindow({ since: "2026-10-01", until: "2026-10-03" }, NOW);
    expect([iso(w.from), iso(w.to)]).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-04T00:00:00.000Z"]);
    expect(iso(parseWindow({ since: "2026-10-01", until: "2026-12-01" }, NOW).to)).toBe(iso(NOW));
    expect(iso(parseWindow({ since: "2026-10-01" }, NOW).to)).toBe(iso(NOW));
  });

  it("rejects conflicting or bad flags", () => {
    expect(() => parseWindow({ week: true, days: "3" }, NOW)).toThrow(/Choose one/);
    expect(() => parseWindow({ days: "0" }, NOW)).toThrow(/--days/);
    expect(() => parseWindow({ until: "2026-10-01" }, NOW)).toThrow(/--until needs --since/);
    expect(() => parseWindow({ since: "2026-13-01" }, NOW)).toThrow(/Not a date/);
    expect(() => parseWindow({ tz: "Mars/Olympus" }, NOW)).toThrow(/Unknown time zone/);
    expect(parseWindow({ tz: "utc" }, NOW).timeZone).toBe("UTC");
  });
});

import { describe, expect, it } from "vitest";
import {
  DAILY_CAP_MESSAGE,
  DEFAULT_DAILY_CAP,
  capMessage,
  currentWindow,
  nextMidnight,
  parseDailyCap,
  refundIn,
  reserveIn,
  safeTimeZone,
  untilText,
} from "./daily-cap";

const t = (iso: string) => Date.parse(iso);

describe("nextMidnight", () => {
  it("is the next local midnight", () => {
    expect(nextMidnight(t("2026-10-07T20:40:00Z"), "UTC")).toBe(t("2026-10-08T00:00:00Z"));
    // London is on BST (UTC+1): local midnight is 23:00 UTC.
    expect(nextMidnight(t("2026-10-07T20:40:00Z"), "Europe/London")).toBe(t("2026-10-07T23:00:00Z"));
    // Already the 8th in Tokyo (UTC+9).
    expect(nextMidnight(t("2026-10-07T20:40:00Z"), "Asia/Tokyo")).toBe(t("2026-10-08T15:00:00Z"));
    expect(nextMidnight(t("2026-10-07T20:40:00Z"), "America/Los_Angeles")).toBe(t("2026-10-08T07:00:00Z"));
  });

  it("one millisecond before midnight resets at midnight; at midnight, the next one", () => {
    expect(nextMidnight(t("2026-10-07T23:59:59.999Z"), "UTC")).toBe(t("2026-10-08T00:00:00Z"));
    expect(nextMidnight(t("2026-10-08T00:00:00Z"), "UTC")).toBe(t("2026-10-09T00:00:00Z"));
  });

  it("handles DST days (25 h and a skipped midnight)", () => {
    // London leaves BST on 25 Oct 2026: that day lasts 25 hours.
    expect(nextMidnight(t("2026-10-24T23:30:00Z"), "Europe/London")).toBe(t("2026-10-26T00:00:00Z"));
    // Santiago springs forward at 00:00 on 6 Sep 2026: there is no midnight, the day starts at 01:00 local.
    const reset = nextMidnight(t("2026-09-05T20:00:00Z"), "America/Santiago");
    expect(new Date(reset).toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });
});

describe("parseDailyCap and safeTimeZone", () => {
  it("parses whole numbers and falls back to the default", () => {
    expect(parseDailyCap("2")).toBe(2);
    expect(parseDailyCap("0")).toBe(0);
    for (const bad of [undefined, "", " ", "-1", "1.5", "three"]) expect(parseDailyCap(bad)).toBe(DEFAULT_DAILY_CAP);
  });
  it("accepts IANA zones and refuses the rest", () => {
    expect(safeTimeZone("Europe/London")).toBe("Europe/London");
    expect(safeTimeZone("Not/AZone")).toBe("UTC");
    expect(safeTimeZone(undefined)).toBe("UTC");
    expect(safeTimeZone(42)).toBe("UTC");
  });
});

describe("the window", () => {
  const now = t("2026-10-07T20:40:00Z");

  it("allows `cap` sources a day, counts each once, and refuses the next", () => {
    let w = currentWindow(undefined, now, "Europe/London");
    for (const id of ["a", "b"]) {
      const r = reserveIn(w, id, 2);
      expect(r).toMatchObject({ ok: true, counted: true });
      w = r.window;
    }
    expect(reserveIn(w, "a", 2)).toMatchObject({ ok: true, counted: false }); // a retried complete
    expect(reserveIn(w, "c", 2).ok).toBe(false);
    expect(w.resetAt).toBe(t("2026-10-07T23:00:00Z"));
  });

  it("resets across the boundary, and keeps its time zone until then", () => {
    const w = { resetAt: t("2026-10-07T23:00:00Z"), timeZone: "Europe/London", sourceIds: ["a", "b"] };
    // A different zone mid-window changes nothing.
    expect(currentWindow(w, t("2026-10-07T22:59:59.999Z"), "Pacific/Kiritimati")).toBe(w);
    const after = currentWindow(w, t("2026-10-07T23:00:00Z"), "Europe/London");
    expect(after).toEqual({ resetAt: t("2026-10-08T23:00:00Z"), timeZone: "Europe/London", sourceIds: [] });
    expect(reserveIn(after, "c", 2).ok).toBe(true);
  });

  it("ignores a stored value of the wrong shape", () => {
    expect(currentWindow({ resetAt: "soon" }, now, "UTC").sourceIds).toEqual([]);
  });

  it("refunds a counted source once", () => {
    const w = { resetAt: now + 1000, timeZone: "UTC", sourceIds: ["a", "b"] };
    const r = refundIn(w, "a");
    expect(r).toEqual({ refunded: true, window: { ...w, sourceIds: ["b"] } });
    expect(refundIn(r.window, "a").refunded).toBe(false);
  });
});

describe("capMessage", () => {
  it("keeps the CLAUDE.md sentence and appends the reset time", () => {
    const w = { resetAt: t("2026-10-07T23:00:00Z"), timeZone: "Europe/London", sourceIds: ["a"] };
    const msg = capMessage(w, t("2026-10-07T19:40:00Z"));
    expect(msg.startsWith(DAILY_CAP_MESSAGE)).toBe(true);
    expect(msg).toBe("You have hit today's limit. It resets at midnight. That's in 3 h 20 min (Thu 8 Oct, 00:00 BST).");
    const chicago = { resetAt: t("2026-10-08T05:00:00Z"), timeZone: "America/Chicago", sourceIds: ["a"] };
    expect(capMessage(chicago, t("2026-10-07T23:18:00Z"))).toBe(
      "You have hit today's limit. It resets at midnight. That's in 5 h 42 min (Thu 8 Oct, 00:00 CDT).",
    );
    expect(capMessage({ ...chicago, resetAt: t("2026-10-07T15:00:00Z"), timeZone: "Asia/Tokyo" }, t("2026-10-07T14:00:00Z"))).toBe(
      "You have hit today's limit. It resets at midnight. That's in 1 h (Thu 8 Oct, 00:00 GMT+9).",
    );
  });
  it("words the wait", () => {
    expect(untilText(1)).toBe("1 min");
    expect(untilText(45 * 60_000)).toBe("45 min");
    expect(untilText(2 * 3_600_000)).toBe("2 h");
    expect(untilText(2 * 3_600_000 + 1)).toBe("2 h 1 min");
  });
});

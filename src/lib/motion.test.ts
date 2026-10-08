import { describe, expect, it } from "vitest";
import { COUNT_UP_MS, countUpValue, easeOutCubic } from "./motion";

describe("countUpValue", () => {
  it("starts at 0 and ends exactly on the target", () => {
    expect(countUpValue(87, 0)).toBe(0);
    expect(countUpValue(87, COUNT_UP_MS)).toBe(87);
    expect(countUpValue(87, COUNT_UP_MS * 5)).toBe(87);
  });

  it("rises without ever passing the target", () => {
    let prev = 0;
    for (let ms = 0; ms <= COUNT_UP_MS; ms += 16) {
      const v = countUpValue(100, ms);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(100);
      prev = v;
    }
  });

  it("eases out: most of the way there by the halfway mark", () => {
    expect(countUpValue(100, COUNT_UP_MS / 2)).toBe(Math.round(100 * easeOutCubic(0.5)));
    expect(countUpValue(100, COUNT_UP_MS / 2)).toBeGreaterThan(80);
  });

  it("handles 0%, a zero duration and negative time", () => {
    expect(countUpValue(0, 500)).toBe(0);
    expect(countUpValue(42, 0, 0)).toBe(42);
    expect(countUpValue(42, -10)).toBe(0);
  });
});

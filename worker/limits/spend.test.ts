import { describe, expect, it } from "vitest";
import { DEFAULT_SPEND_CEILING_USD, RESERVE_PER_RUN_USD, ceilingAllows, monthStart, parseSpendCeiling, stableUuid } from "./spend";

describe("spend ceiling rules", () => {
  it("sums from 00:00 UTC on the 1st", () => {
    expect(monthStart(new Date("2026-10-07T20:40:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-10-31T23:59:59.999Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-11-01T00:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(monthStart(new Date("2027-01-01T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("allows a run only if its reservation fits under the ceiling", () => {
    expect(RESERVE_PER_RUN_USD).toBeGreaterThan(0.157); // the worst run measured (STM-19)
    expect(ceilingAllows(0, 15)).toBe(true);
    expect(ceilingAllows(14.8, 15)).toBe(true); // exactly at the ceiling
    expect(ceilingAllows(14.800001, 15)).toBe(false);
    expect(ceilingAllows(15.2, 15)).toBe(false);
    expect(ceilingAllows(0, 0)).toBe(false); // a ceiling of 0 turns generation off
  });

  it("parses the ceiling", () => {
    expect(parseSpendCeiling("2.5")).toBe(2.5);
    expect(parseSpendCeiling("0")).toBe(0);
    for (const bad of [undefined, "", "-1", "lots"]) expect(parseSpendCeiling(bad)).toBe(DEFAULT_SPEND_CEILING_USD);
  });

  it("makes stable, distinct UUIDs", async () => {
    const a = await stableUuid("source-1", "reservation");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await stableUuid("source-1", "reservation")).toBe(a);
    expect(await stableUuid("source-1", "generate:1")).not.toBe(a);
    expect(await stableUuid("source-1re", "servation")).not.toBe(a);
  });
});

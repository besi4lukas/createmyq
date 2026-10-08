import { describe, expect, it } from "vitest";
import { agreement, difficultyConfusion, type TagRow } from "./tag-metrics";

const row = (label: TagRow["label"], got: TagRow["got"]): TagRow => ({ id: "x", label, got, confidence: 0.8 });

describe("difficulty agreement", () => {
  it("counts exact matches, two-level misses and the confusion matrix", () => {
    const rows = [row("beginner", "beginner"), row("intermediate", "intermediate"), row("advanced", "intermediate"), row("beginner", "advanced")];
    const a = agreement(rows);
    expect(a).toMatchObject({ total: 4, exact: 2, offByTwo: 1 });
    // observed 0.5; chance = (2/4·1/4) + (1/4·2/4) + (1/4·1/4) = 0.3125
    expect(a.kappa).toBeCloseTo((0.5 - 0.3125) / (1 - 0.3125));
    const m = difficultyConfusion(rows);
    expect(m.advanced.intermediate).toBe(1);
    expect(m.beginner.advanced).toBe(1);
    expect(m.intermediate.intermediate).toBe(1);
  });

  it("is 1 for perfect agreement across levels", () => {
    expect(agreement([row("beginner", "beginner"), row("advanced", "advanced")]).kappa).toBe(1);
  });
});

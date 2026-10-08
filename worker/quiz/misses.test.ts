import { describe, expect, it } from "vitest";
import { RESOLVE_AFTER, foldMiss, groupHistory, type Outcome } from "./misses";

const t = (min: number) => new Date(Date.UTC(2026, 9, 7, 12, min));
const h = (...verdicts: Outcome["verdict"][]): Outcome[] => verdicts.map((verdict, i) => ({ at: t(i), verdict }));

describe("foldMiss", () => {
  it("is null for a question never missed", () => {
    expect(foldMiss([])).toBeNull();
    expect(foldMiss(h("correct", "correct", "correct"))).toBeNull();
  });

  it("opens on a wrong answer, an unanswered question or a partial", () => {
    for (const v of ["incorrect", null, "partial"] as const) {
      expect(foldMiss(h("correct", v))).toEqual({ missedAt: t(1), resolvedAt: null, correctStreak: 0 });
    }
  });

  it("counts correct answers in a row and resolves at two", () => {
    expect(RESOLVE_AFTER).toBe(2);
    expect(foldMiss(h("incorrect", "correct"))).toEqual({ missedAt: t(0), resolvedAt: null, correctStreak: 1 });
    expect(foldMiss(h("incorrect", "correct", "correct"))).toEqual({
      missedAt: t(0),
      resolvedAt: t(2),
      correctStreak: 2,
    });
  });

  it("resets the streak on a wrong answer (consecutive, not total)", () => {
    expect(foldMiss(h("incorrect", "correct", "incorrect", "correct"))).toEqual({
      missedAt: t(2),
      resolvedAt: null,
      correctStreak: 1,
    });
    expect(foldMiss(h("incorrect", "correct", null))).toEqual({ missedAt: t(2), resolvedAt: null, correctStreak: 0 });
  });

  it("stays resolved on further correct answers and re-opens on a new miss", () => {
    const resolved = { missedAt: t(0), resolvedAt: t(2), correctStreak: 2 };
    expect(foldMiss(h("incorrect", "correct", "correct", "correct"))).toEqual(resolved);
    expect(foldMiss(h("incorrect", "correct", "correct", "correct", "incorrect"))).toEqual({
      missedAt: t(4),
      resolvedAt: null,
      correctStreak: 0,
    });
  });

  it("is deterministic: replaying the same history gives the same row (no double count)", () => {
    const history = h("incorrect", "correct");
    expect(foldMiss(history)).toEqual(foldMiss(history));
    expect(foldMiss(history)!.correctStreak).toBe(1);
  });
});

describe("groupHistory", () => {
  it("groups by question, keeping the order of the rows", () => {
    const rows = [
      { question_id: "a", at: t(0).toISOString(), verdict: "incorrect" as const },
      { question_id: "b", at: t(1), verdict: null },
      { question_id: "a", at: t(2), verdict: "correct" as const },
    ];
    expect([...groupHistory(rows)]).toEqual([
      ["a", [{ at: t(0), verdict: "incorrect" }, { at: t(2), verdict: "correct" }]],
      ["b", [{ at: t(1), verdict: null }]],
    ]);
  });
});

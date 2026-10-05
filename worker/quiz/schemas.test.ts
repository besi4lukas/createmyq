import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, answerBody, finishBody, mergePrefs, readPrefs, startBody } from "./schemas";

const uuid = "8b0f7c0e-5d7a-4b1e-9d3c-2f6a1e0b9c11";

describe("request bodies", () => {
  it("start: numbers for length, known mode and difficulty, no extra keys", () => {
    const ok = { category: "system-design", difficulty: "beginner", length: 10, mode: "exam" };
    expect(startBody.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, length: "10" },
      { ...ok, length: 15 },
      { ...ok, mode: "quiz" },
      { ...ok, category: "System Design" },
      { ...ok, extra: 1 },
    ]) {
      expect(startBody.safeParse(bad).success).toBe(false);
    }
  });

  it("answer and finish need a uuid quizId and bounded integers", () => {
    expect(answerBody.safeParse({ quizId: uuid, index: 19, option: 3 }).success).toBe(true);
    expect(answerBody.safeParse({ quizId: uuid, index: 20, option: 0 }).success).toBe(false);
    expect(answerBody.safeParse({ quizId: uuid, index: 0, option: 4 }).success).toBe(false);
    expect(answerBody.safeParse({ quizId: uuid, index: 0.5, option: 0 }).success).toBe(false);
    expect(answerBody.safeParse({ quizId: "nope", index: 0, option: 0 }).success).toBe(false);
    expect(finishBody.safeParse({ quizId: uuid }).success).toBe(true);
    expect(finishBody.safeParse({ quizId: uuid, x: 1 }).success).toBe(false);
  });
});

describe("prefs", () => {
  it("reads defaults for missing or invalid storage", () => {
    expect(readPrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(readPrefs({ ...DEFAULT_PREFS, defaultLength: 7 })).toEqual(DEFAULT_PREFS);
    expect(readPrefs({ ...DEFAULT_PREFS, defaultMode: "exam" }).defaultMode).toBe("exam");
  });

  it("merges a patch and rejects a bad one", () => {
    expect(mergePrefs(DEFAULT_PREFS, { defaultDifficulty: "advanced" })).toEqual({ ...DEFAULT_PREFS, defaultDifficulty: "advanced" });
    expect(() => mergePrefs(DEFAULT_PREFS, { formats: [] })).toThrow();
    expect(() => mergePrefs(DEFAULT_PREFS, { theme: "dark" } as never)).toThrow();
  });
});

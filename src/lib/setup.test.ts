import { describe, expect, it } from "vitest";
import type { Prefs } from "./quiz";
import {
  INLINE_DEFAULT_LENGTH,
  availableFormats,
  setupFromPrefs,
  toggleFormat,
} from "./setup";

const prefs: Prefs = {
  defaultDifficulty: "advanced",
  defaultMode: "exam",
  defaultLength: 20,
  formats: ["multiple_choice"],
};

describe("toggleFormat", () => {
  it("keeps at least one format on", () => {
    expect(toggleFormat(["multiple_choice"], "multiple_choice")).toEqual(["multiple_choice"]);
  });

  it("won't turn on a format quizzes can't serve yet", () => {
    expect(toggleFormat(["multiple_choice"], "short_answer")).toEqual(["multiple_choice"]);
  });

  it("turns an extra format off, keeping display order", () => {
    expect(toggleFormat(["multiple_choice", "short_answer"], "short_answer")).toEqual(["multiple_choice"]);
    expect(toggleFormat(["multiple_choice", "short_answer"], "multiple_choice")).toEqual(["short_answer"]);
  });
});

describe("availableFormats", () => {
  it("drops formats that can't be served and never returns none", () => {
    expect(availableFormats(["multiple_choice", "short_answer"])).toEqual(["multiple_choice"]);
    expect(availableFormats(["short_answer"])).toEqual(["multiple_choice"]);
    expect(availableFormats([])).toEqual(["multiple_choice"]);
  });
});

describe("setupFromPrefs", () => {
  it("prefills difficulty, mode and formats; the Setup page keeps the saved length", () => {
    expect(setupFromPrefs(prefs)).toEqual({
      difficulty: "advanced",
      mode: "exam",
      length: 20,
      formats: ["multiple_choice"],
    });
  });

  it("Home's inline setup starts at 5 questions", () => {
    expect(INLINE_DEFAULT_LENGTH).toBe(5);
    expect(setupFromPrefs(prefs, INLINE_DEFAULT_LENGTH).length).toBe(5);
  });
});

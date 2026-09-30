import { describe, expect, it } from "vitest";
import type { Quiz } from "../lib/quiz";
import { optionsPhaseOf, startingPoint } from "./useQuizRunner";

const quiz = (mode: Quiz["mode"], currentIndex: number): Quiz => ({
  quizId: "q",
  category: "system-design",
  difficulty: "beginner",
  mode,
  length: 5,
  questionCount: 3,
  startedAt: "",
  currentIndex,
  questions: [],
  answers: [],
});

describe("startingPoint (resume)", () => {
  it("resumes at the first unanswered question", () => {
    expect(startingPoint(quiz("practice", 0))).toEqual({ index: 0, phase: "answering" });
    expect(startingPoint(quiz("exam", 2))).toEqual({ index: 2, phase: "answering" });
  });

  it("with every answer in: Practice shows the last verdict, Exam finishes", () => {
    expect(startingPoint(quiz("practice", 3))).toEqual({ index: 2, phase: "revealed" });
    expect(startingPoint(quiz("exam", 3))).toEqual({ index: 2, phase: "finishing" });
  });
});

describe("optionsPhaseOf", () => {
  it("locks the options while finishing or after a failed finish", () => {
    expect(["answering", "checking", "revealed", "finishing", "finish-failed"].map((p) => optionsPhaseOf(p as never))).toEqual([
      "answering",
      "checking",
      "revealed",
      "locked",
      "locked",
    ]);
  });
});

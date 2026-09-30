import { describe, expect, it } from "vitest";
import { assembleQuery, toPublicQuestion, type AssembledQuestion } from "./assemble";

describe("GET /api/quiz query", () => {
  it("accepts a slug, a difficulty and a length of 5, 10 or 20 (as a number)", () => {
    expect(assembleQuery.parse({ category: "system-design", difficulty: "advanced", length: "20" })).toEqual({
      category: "system-design",
      difficulty: "advanced",
      length: 20,
    });
  });

  it.each([
    { category: "System Design", difficulty: "beginner", length: "5" },
    { category: "system-design", difficulty: "expert", length: "5" },
    { category: "system-design", difficulty: "beginner", length: "7" },
    { category: "system-design", difficulty: "beginner" },
    { category: "x".repeat(65), difficulty: "beginner", length: "5" },
  ])("rejects %j", (query) => {
    expect(assembleQuery.safeParse(query).success).toBe(false);
  });
});

describe("toPublicQuestion", () => {
  it("drops the answer and the explanation", () => {
    const q: AssembledQuestion = {
      id: "q1",
      format: "multiple_choice",
      difficulty: "beginner",
      topic: null,
      prompt: "p",
      explanation: "secret explanation",
      payload: { options: ["a", "b", "c", "d"], answer: "c" },
    };
    expect(toPublicQuestion(q)).toEqual({
      id: "q1",
      format: "multiple_choice",
      difficulty: "beginner",
      topic: null,
      prompt: "p",
      options: ["a", "b", "c", "d"],
    });
  });
});

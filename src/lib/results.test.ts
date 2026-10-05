import { describe, expect, it } from "vitest";
import { NO_TOPIC, headlineFor, scorePercent, summarize, topicBreakdown, topicStatus, verdictOf } from "./results";

const item = (topic: string | null, option: number | null, correct: boolean) => ({ topic, option, correct });

describe("verdictOf", () => {
  it("tells correct, wrong and unanswered apart", () => {
    expect(verdictOf(item("a", 0, true))).toBe("correct");
    expect(verdictOf(item("a", 2, false))).toBe("wrong");
    expect(verdictOf(item("a", null, false))).toBe("unanswered");
  });
});

describe("scorePercent and headlineFor", () => {
  it("rounds to a whole percent and never divides by zero", () => {
    expect(scorePercent(2, 3)).toBe(67);
    expect(scorePercent(5, 5)).toBe(100);
    expect(scorePercent(0, 0)).toBe(0);
  });

  it("uses the design's thresholds (80, 50)", () => {
    expect(headlineFor(80)).toBe("You stumped the quiz.");
    expect(headlineFor(79)).toBe("Solid run. A couple got away.");
    expect(headlineFor(50)).toBe("Solid run. A couple got away.");
    expect(headlineFor(49)).toBe("Good warm-up. The misses are saved for later.");
  });
});

describe("topicStatus", () => {
  it("is Solid at 100%, Getting there above 0, Revisit at 0", () => {
    expect(topicStatus(3, 3)).toBe("Solid");
    expect(topicStatus(1, 3)).toBe("Getting there");
    expect(topicStatus(0, 3)).toBe("Revisit");
  });
});

describe("topicBreakdown", () => {
  it("groups by topic in first-seen order and counts correct of total", () => {
    const rows = topicBreakdown([
      item("caching", 0, true),
      item("sharding", 1, false),
      item("caching", 2, false),
      item("caching", 3, true),
    ]);
    expect(rows).toEqual([
      { topic: "caching", correct: 2, total: 3, status: "Getting there" },
      { topic: "sharding", correct: 0, total: 1, status: "Revisit" },
    ]);
  });

  it("counts unanswered questions in the total, never as correct", () => {
    // Defensive: the server sends correct:false for unanswered, but an
    // unanswered question must not count even if it didn't.
    expect(topicBreakdown([item("cdn", 0, true), item("cdn", null, true)])).toEqual([
      { topic: "cdn", correct: 1, total: 2, status: "Getting there" },
    ]);
  });

  it("puts questions without a topic under one label", () => {
    expect(topicBreakdown([item(null, 0, true), item("  ", 1, true)])).toEqual([
      { topic: NO_TOPIC, correct: 2, total: 2, status: "Solid" },
    ]);
  });

  it("is empty for an empty review", () => {
    expect(topicBreakdown([])).toEqual([]);
  });
});

describe("summarize", () => {
  it("gives the percent, headline and how many were left unanswered", () => {
    expect(summarize({ score: 2, questionCount: 5, answered: 2 })).toEqual({
      pct: 40,
      headline: "Good warm-up. The misses are saved for later.",
      unanswered: 3,
    });
    expect(summarize({ score: 4, questionCount: 5, answered: 5 }).unanswered).toBe(0);
  });
});

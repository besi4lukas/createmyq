import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QuizResult, ReviewItem } from "../lib/quiz";
import { ResultScreen } from "./ResultScreen";

const q = (index: number, topic: string, option: number | null, correct: boolean): ReviewItem => ({
  index,
  id: `id${index}`,
  format: "multiple_choice",
  difficulty: "beginner",
  topic,
  prompt: `Prompt ${index}`,
  options: ["A", "B", "C", "D"],
  option,
  choice: option === null ? null : ["A", "B", "C", "D"][option]!,
  correct,
  correctAnswer: "A",
  explanation: `Why ${index}`,
});

// Finished early: two answered (one right), one never reached.
const result: QuizResult = {
  quizId: "quiz",
  kind: "category",
  sourceId: null,
  sourceTitle: null,
  category: "system-design",
  difficulty: "beginner",
  mode: "exam",
  score: 1,
  questionCount: 3,
  answered: 2,
  review: [q(0, "caching", 0, true), q(1, "caching", 2, false), q(2, "cdn", null, false)],
};

const html = renderToStaticMarkup(createElement(ResultScreen, { result, onStarted: () => {} }));
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("ResultScreen", () => {
  it("shows the score, says it in the focusable heading, and summarises", () => {
    const [, attrs = "", heading = ""] = /<h1([^>]*)>(.*?)<\/h1>/.exec(html) ?? [];
    expect(attrs).toContain("data-autofocus");
    expect(attrs).toContain('tabindex="-1"');
    expect(heading.replace(/<[^>]+>/g, "")).toBe("You scored 33%. Good warm-up. The misses are saved for later.");
    expect(text).toContain("1 of 3 right, 1 not answered, System Design, Beginner");
  });

  it("breaks the score down by topic", () => {
    expect(text).toContain("caching 1 of 2 Getting there");
    expect(text).toContain("cdn 0 of 1 Revisit");
  });

  it("lists every question with a verdict word, the answer and the explanation", () => {
    expect(text).toContain("Prompt 0 Correct You said: A Why 0");
    expect(text).toContain("Prompt 1 Not quite You said: C Answer: A Why 1");
    // Unanswered: no "You said", but still the answer and why.
    expect(text).toContain("Prompt 2 Not answered Answer: A Why 2");
  });

  it("offers Another round and Home; the review action waits for the miss count (loaded after mount)", () => {
    expect(text).toContain("Another round");
    expect(text).toContain("Home");
    expect(text).not.toContain("Review what I missed");
  });

  it("names a review quiz (STM-25) and has no Another round for it", () => {
    const review: QuizResult = { ...result, kind: "review", category: null, difficulty: null };
    const out = renderToStaticMarkup(createElement(ResultScreen, { result: review, onStarted: () => {} }))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    expect(out).toContain("1 of 3 right, 1 not answered, Review what I missed, Mixed levels");
    expect(out).not.toContain("Another round");
  });
});

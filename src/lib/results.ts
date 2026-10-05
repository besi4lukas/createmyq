/**
 * The results screen's numbers (STM-12), derived from the finish response's
 * `review[]`: pure functions, no React. The server already sends every
 * question with its topic and verdict, so nothing here needs a new API field.
 */
import type { QuizResult, ReviewItem } from "./quiz";

/** How one question went. Unanswered = the quiz was finished before it was reached. */
export type Verdict = "correct" | "wrong" | "unanswered";

export function verdictOf(item: Pick<ReviewItem, "option" | "correct">): Verdict {
  if (item.option === null) return "unanswered";
  return item.correct ? "correct" : "wrong";
}

/** Whole percent, as the big number shows it. An empty quiz (never served) is 0. */
export function scorePercent(score: number, questionCount: number): number {
  return questionCount > 0 ? Math.round((score / questionCount) * 100) : 0;
}

/** The design's headline by score (Results B), verbatim. */
export function headlineFor(pct: number): string {
  if (pct >= 80) return "You stumped the quiz.";
  if (pct >= 50) return "Solid run. A couple got away.";
  return "Good warm-up. The misses are saved for later.";
}

/** "Solid" = all right, "Getting there" = some, "Revisit" = none. */
export type TopicStatus = "Solid" | "Getting there" | "Revisit";

export type TopicRow = { topic: string; correct: number; total: number; status: TopicStatus };

/** Questions without a topic are grouped under this label. */
export const NO_TOPIC = "Other";

export function topicStatus(correct: number, total: number): TopicStatus {
  if (total > 0 && correct >= total) return "Solid";
  return correct > 0 ? "Getting there" : "Revisit";
}

/**
 * One row per topic, in the order topics first appear in the quiz. Unanswered
 * questions count toward the total and not toward correct, as in the score.
 */
export function topicBreakdown(review: readonly Pick<ReviewItem, "topic" | "option" | "correct">[]): TopicRow[] {
  const rows = new Map<string, { correct: number; total: number }>();
  for (const item of review) {
    const topic = item.topic?.trim() || NO_TOPIC;
    const row = rows.get(topic) ?? { correct: 0, total: 0 };
    row.total += 1;
    if (verdictOf(item) === "correct") row.correct += 1;
    rows.set(topic, row);
  }
  return [...rows].map(([topic, { correct, total }]) => ({ topic, correct, total, status: topicStatus(correct, total) }));
}

/** Everything the screen shows above the lists. */
export function summarize(result: Pick<QuizResult, "score" | "questionCount" | "answered">) {
  const pct = scorePercent(result.score, result.questionCount);
  return {
    pct,
    headline: headlineFor(pct),
    unanswered: Math.max(0, result.questionCount - result.answered),
  };
}

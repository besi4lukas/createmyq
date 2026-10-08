import { ArrowCounterClockwise, CheckCircle, MinusCircle, XCircle, type Icon } from "@phosphor-icons/react";
import { ErrorNotice, Tag } from "../components/Bits";
import { Button } from "../components/Button";
import { navigate } from "../lib/router";
import { difficultyLabel, quizTitle, type Quiz, type QuizResult } from "../lib/quiz";
import { useReview } from "../lib/useReview";
import { summarize, topicBreakdown, verdictOf, type TopicStatus, type Verdict } from "../lib/results";

/** Right and wrong are never colour alone: every verdict has its own icon and word. */
const VERDICT: Record<Verdict, { Icon: Icon; label: string; tone: string }> = {
  correct: { Icon: CheckCircle, label: "Correct", tone: "text-accent-300" },
  wrong: { Icon: XCircle, label: "Not quite", tone: "text-wrong" },
  unanswered: { Icon: MinusCircle, label: "Not answered", tone: "text-neutral-400" },
};

const STATUS_TONE: Record<TopicStatus, "accent" | "neutral"> = {
  Solid: "accent",
  "Getting there": "neutral",
  Revisit: "neutral",
};

/**
 * The results screen (STM-12, layout B "Big number"): the score, a per-topic
 * breakdown, and every question with the user's answer, the right answer and
 * the explanation. Everything is derived from the finish response during
 * render. App moves focus to the heading (data-autofocus) on arrival.
 *
 * STM-25: "Review what I missed" starts a review quiz from every unresolved
 * miss (this quiz's are already in Postgres: finish waits for the flush). It
 * is replaced by a plain sentence when there is nothing to review.
 * Deferred: the score count-up (STM-26).
 */
export function ResultScreen({
  result,
  onStarted,
}: {
  result: QuizResult;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const { pct, headline, unanswered } = summarize(result);
  const topics = topicBreakdown(result.review);
  const summary = [
    `${result.score} of ${result.questionCount} right`,
    unanswered > 0 && `${unanswered} not answered`,
    quizTitle(result),
    difficultyLabel(result.difficulty),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex max-w-[760px] flex-col gap-7.5 pt-3">
      <div>
        {/* The heading below says the score for screen readers. */}
        <p
          aria-hidden="true"
          className="text-score leading-[0.9] font-medium tracking-[-0.05em] text-accent-300 sm:text-score-lg"
        >
          {pct}
          <span className="text-[0.4em] tracking-normal text-neutral-500">%</span>
        </p>
        <h1 data-autofocus tabIndex={-1} className="mt-3.5 text-h2-phone text-balance outline-none sm:text-h2">
          <span className="sr-only">You scored {pct}%. </span>
          {headline}
        </h1>
        <p className="mt-1.5 text-muted">{summary}</p>
      </div>

      <section aria-labelledby="by-topic" className="flex flex-col gap-3">
        <h2 id="by-topic" className="section-label">
          By topic
        </h2>
        <table aria-labelledby="by-topic" className="w-full border-collapse text-ui">
          <thead>
            <tr className="rule-fade">
              {["Topic", "Score", "Status"].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="p-1.5 text-left text-tag font-medium tracking-[0.08em] text-text/60 uppercase"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topics.map((t) => (
              <tr key={t.topic} className="rule-fade-faint">
                <th scope="row" className="p-1.5 text-left font-normal">
                  {t.topic}
                </th>
                <td className="p-1.5 whitespace-nowrap">
                  {t.correct} of {t.total}
                </td>
                <td className="p-1.5">
                  <Tag tone={STATUS_TONE[t.status]}>{t.status}</Tag>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="every-question" className="flex flex-col gap-1">
        <h2 id="every-question" className="section-label mb-2">
          Every question
        </h2>
        <ol className="flex flex-col">
          {result.review.map((item) => {
            const verdict = verdictOf(item);
            const { Icon, label, tone } = VERDICT[verdict];
            return (
              <li key={item.index} className="rule-fade flex gap-3.5 py-3.5">
                <Icon aria-hidden="true" weight="fill" className={`size-5.5 shrink-0 ${tone}`} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-ui text-pretty">
                    <span className="sr-only">Question {item.index + 1}: </span>
                    {item.prompt}
                  </p>
                  <p className={`text-meta ${tone}`}>{label}</p>
                  {verdict !== "unanswered" && <p className="text-meta text-muted">You said: {item.choice}</p>}
                  {verdict !== "correct" && <p className="text-meta text-accent-300">Answer: {item.correctAnswer}</p>}
                  <p className="mt-1 text-small text-pretty text-neutral-300">{item.explanation}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <ResultActions result={result} onStarted={onStarted} />
    </div>
  );
}

function ResultActions({
  result,
  onStarted,
}: {
  result: QuizResult;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const { count, start, starting, error } = useReview(onStarted);
  const toReview = count.status === "ok" ? count.data : 0;
  const category = result.category;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2.5">
        {toReview > 0 && (
          <Button size="lg" disabled={starting} aria-busy={starting} onClick={() => void start()}>
            <ArrowCounterClockwise aria-hidden="true" className="size-4.5" />
            Review what I missed ({toReview})
          </Button>
        )}
        {category !== null && (
          <Button size="lg" variant="secondary" onClick={() => navigate({ name: "setup", category })}>
            Another round
          </Button>
        )}
        <Button size="lg" variant="ghost" onClick={() => navigate({ name: "home" })}>
          Home
        </Button>
      </div>
      {count.status === "ok" && toReview === 0 && (
        <p role="status" className="text-small text-muted">
          Nothing to review. Questions you miss come back here until you get them right twice in a row.
        </p>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </div>
  );
}

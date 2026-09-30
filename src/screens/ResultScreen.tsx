import { ArrowRight, CheckCircle, XCircle } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { navigate } from "../lib/router";
import { DIFFICULTY_LABEL, categoryName, type QuizResult } from "../lib/quiz";

/**
 * A deliberately small stand-in so the quiz loop completes: the score and each
 * answer. The full results screen (topic breakdown, explanations, count-up) is
 * STM-12.
 */
export function ResultScreen({ result }: { result: QuizResult }) {
  const { score, questionCount } = result;
  const pct = questionCount ? Math.round((score / questionCount) * 100) : 0;
  const headline =
    pct >= 80 ? "You stumped the quiz." : pct >= 50 ? "Solid run. A couple got away." : "Good warm-up.";

  return (
    <div className="flex max-w-[760px] flex-col gap-7.5 pt-3">
      <div>
        <p className="text-score leading-[0.9] font-medium tracking-[-0.05em] text-accent-300">
          {pct}
          <span className="text-[0.4em] tracking-normal text-neutral-500">%</span>
        </p>
        <h1 className="mt-3.5 text-h2-phone text-balance sm:text-h2">{headline}</h1>
        <p className="mt-1.5 text-muted">
          {score} of {questionCount} right, {categoryName(result.category)}, {DIFFICULTY_LABEL[result.difficulty]}
        </p>
        <p className="mt-3 text-small text-muted">
          A fuller results screen, with every explanation and a topic breakdown, is on its way.
        </p>
      </div>

      <section aria-labelledby="every-question" className="flex flex-col gap-1">
        <h2 id="every-question" className="section-label mb-2">
          Every question
        </h2>
        <ol className="flex flex-col">
          {result.review.map((item) => {
            const Icon = item.correct ? CheckCircle : XCircle;
            return (
              <li key={item.index} className="rule-fade flex gap-3.5 py-3.5">
                <Icon
                  aria-hidden="true"
                  weight="fill"
                  className={`size-5.5 shrink-0 ${item.correct ? "text-accent-300" : "text-wrong"}`}
                />
                <div className="flex flex-1 flex-col gap-1">
                  <p className="text-ui text-pretty">{item.prompt}</p>
                  <p className={`text-meta ${item.correct ? "text-accent-300" : "text-wrong"}`}>
                    {item.correct ? "Correct" : "Not quite"}
                  </p>
                  <p className="text-meta text-muted">You said: {item.choice ?? "No answer"}</p>
                  {!item.correct && <p className="text-meta text-accent-300">Answer: {item.correctAnswer}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="flex flex-wrap gap-2.5">
        <Button size="lg" onClick={() => navigate({ name: "setup", category: result.category })}>
          Another round
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
        <Button size="lg" variant="ghost" onClick={() => navigate({ name: "home" })}>
          Home
        </Button>
      </div>
    </div>
  );
}

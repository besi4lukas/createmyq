import { ArrowRight, PlayPause } from "@phosphor-icons/react";
import { useUser } from "@clerk/react";
import { Button } from "../components/Button";
import { ErrorNotice } from "../components/Bits";
import { navigate } from "../lib/router";
import { CATEGORIES, DIFFICULTY_LABEL, categoryName, getActiveQuiz, type Quiz } from "../lib/quiz";
import { useAsync } from "../lib/useAsync";

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
}

export function HomeScreen() {
  const { user } = useUser();
  const active = useAsync(getActiveQuiz);

  const name = user?.firstName?.trim();

  return (
    <div className="flex max-w-[1000px] flex-col gap-7">
      <div className="pt-3">
        <h1 className="text-h2-phone sm:text-h2">
          {greeting()}
          {name ? `, ${name}` : ""}. What are we learning?
        </h1>
        <p className="mt-1.5 text-muted">Take a built-in quiz and see what you actually know.</p>
      </div>

      {active.status === "ok" && active.data && <ResumeCard quiz={active.data} />}
      {active.status === "error" && (
        <ErrorNotice>
          We could not check for a quiz in progress. {active.message}
        </ErrorNotice>
      )}

      <section aria-labelledby="builtin" className="flex max-w-[486px] flex-col gap-3">
        <h2 id="builtin" className="section-label">
          Built-in
        </h2>
        {CATEGORIES.map((c) => (
          <div key={c.slug} className="flex flex-col gap-2 rounded-md bg-surface p-4.5">
            <div className="kicker">Multiple choice, three levels</div>
            <h3 className="text-title leading-tight">{c.name}</h3>
            <p className="text-small opacity-80">{c.blurb}</p>
            <div className="mt-1.5">
              <Button onClick={() => navigate({ name: "setup", category: c.slug })}>
                Start a quiz
                <ArrowRight aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function ResumeCard({ quiz }: { quiz: Quiz }) {
  const answered = Math.min(quiz.currentIndex, quiz.questionCount);
  return (
    <div className="flex flex-wrap items-center gap-3.5 rounded-md bg-surface px-4 py-3.5 shadow-sm">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-panel bg-accent-900 text-accent-300"
      >
        <PlayPause className="size-5" />
      </span>
      <div className="min-w-40 flex-1">
        <div className="text-ui">Pick up where you left off</div>
        <div className="text-meta text-muted">
          {categoryName(quiz.category)}, {DIFFICULTY_LABEL[quiz.difficulty]}, {answered} of {quiz.questionCount}{" "}
          answered
        </div>
      </div>
      <Button onClick={() => navigate({ name: "quiz" })}>Resume</Button>
    </div>
  );
}

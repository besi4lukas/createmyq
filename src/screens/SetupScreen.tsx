import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, SlidersHorizontal } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading } from "../components/Bits";
import { QuizSetupFields } from "../components/QuizSetupFields";
import { navigate } from "../lib/router";
import { CATEGORIES, getPrefs, type Prefs, type Quiz } from "../lib/quiz";
import { setupFromPrefs } from "../lib/setup";
import { useAsync } from "../lib/useAsync";
import { useStartQuiz } from "../lib/useStartQuiz";

/**
 * The full setup page, /setup/<category>. Home's category cards set up a quiz
 * inline now; this page stays for "Another round" on Results and for the
 * saved-source flow to come. The fields are QuizSetupFields, shared with Home.
 */
export function SetupScreen({
  category,
  onStarted,
}: {
  category: string;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const cat = CATEGORIES.find((c) => c.slug === category);
  const prefs = useAsync(getPrefs);

  if (!cat) {
    return (
      <Column>
        <BackButton />
        <ErrorNotice>That category does not exist.</ErrorNotice>
      </Column>
    );
  }

  return (
    <Column>
      <BackButton />
      <div>
        <div className="kicker mb-1.5">Built-in</div>
        <h1 className="text-h2-phone sm:text-h2">{cat.name}</h1>
        <p className="mt-1.5 flex items-center gap-1.5 text-small text-muted">
          <SlidersHorizontal aria-hidden="true" className="shrink-0" />
          Filled in from your preferences. Change anything for this quiz.
        </p>
      </div>
      {prefs.status === "error" && (
        <ErrorNotice
          action={
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Try again
            </Button>
          }
        >
          {prefs.message}
        </ErrorNotice>
      )}
      {prefs.status === "loading" && <Loading />}
      {prefs.status === "ok" && <SetupForm category={cat.slug} prefs={prefs.data} onStarted={onStarted} />}
    </Column>
  );
}

function SetupForm({
  category,
  prefs,
  onStarted,
}: {
  category: string;
  prefs: Prefs;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const [values, setValues] = useState(() => setupFromPrefs(prefs));
  const { start, starting, error } = useStartQuiz(category, onStarted);

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void start(values);
      }}
    >
      <QuizSetupFields values={values} onChange={setValues} />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div>
        <Button type="submit" size="lg" disabled={starting} aria-busy={starting}>
          {starting ? "Starting…" : "Start quiz"}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </form>
  );
}

function Column({ children }: { children: ReactNode }) {
  return <div className="flex max-w-[560px] flex-col gap-6 pt-3">{children}</div>;
}

function BackButton() {
  return (
    <Button
      variant="ghost"
      className="self-start px-1.5"
      onClick={() => navigate({ name: "home" })}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back
    </Button>
  );
}

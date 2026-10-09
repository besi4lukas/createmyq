import { useCallback, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, SlidersHorizontal } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading } from "../components/Bits";
import { QuizSetupFields } from "../components/QuizSetupFields";
import { navigate } from "../lib/router";
import { CATEGORIES, getPrefs, type Prefs, type Quiz } from "../lib/quiz";
import { setupFromPrefs } from "../lib/setup";
import { getSource } from "../lib/sources";
import { sourceName } from "../lib/upload-card";
import { useAsync } from "../lib/useAsync";
import { useStartQuiz, type StartTarget } from "../lib/useStartQuiz";

/**
 * The full setup page: /setup/<category>, or /sources/<id>/setup for one of
 * the user's sources. Home sets up quizzes inline now; this page stays for
 * deep links, "Another round" on Results and the source status page's "Set up
 * the quiz". The fields are QuizSetupFields, shared with Home.
 */
export function SetupScreen({
  category,
  onStarted,
}: {
  category: string;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const cat = CATEGORIES.find((c) => c.slug === category);

  if (!cat) {
    return (
      <Column>
        <BackButton />
        <ErrorNotice>That category does not exist.</ErrorNotice>
      </Column>
    );
  }
  return <SetupPage kicker="Built-in" title={cat.name} target={{ category: cat.slug }} onStarted={onStarted} />;
}

/** /sources/<id>/setup: "Your source, 23 questions" and the source's name. */
export function SourceSetupScreen({ id, onStarted }: { id: string; onStarted: (quiz: Quiz, resumed: boolean) => void }) {
  const source = useAsync(useCallback(() => getSource(id), [id]));
  if (source.status === "loading") {
    return (
      <Column>
        <BackButton />
        <Loading />
      </Column>
    );
  }
  if (source.status === "error" || source.data.status !== "ready") {
    return (
      <Column>
        <BackButton />
        <ErrorNotice>{source.status === "error" ? source.message : "This source has no quiz yet."}</ErrorNotice>
      </Column>
    );
  }
  const n = source.data.questionCount;
  return (
    <SetupPage
      kicker={`Your source, ${n} ${n === 1 ? "question" : "questions"}`}
      title={sourceName(source.data)}
      target={{ sourceId: id }}
      onStarted={onStarted}
    />
  );
}

function SetupPage({
  kicker,
  title,
  target,
  onStarted,
}: {
  kicker: string;
  title: string;
  target: StartTarget;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const prefs = useAsync(getPrefs);
  return (
    <Column>
      <BackButton />
      <div>
        <div className="kicker mb-1.5">{kicker}</div>
        <h1 className="text-h2-phone sm:text-h2 break-words">{title}</h1>
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
      {prefs.status === "ok" && <SetupForm target={target} prefs={prefs.data} onStarted={onStarted} />}
    </Column>
  );
}

function SetupForm({
  target,
  prefs,
  onStarted,
}: {
  target: StartTarget;
  prefs: Prefs;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const [values, setValues] = useState(() => setupFromPrefs(prefs));
  const { start, starting, error } = useStartQuiz(target, onStarted);

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

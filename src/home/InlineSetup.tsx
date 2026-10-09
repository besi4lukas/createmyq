/**
 * The setup inside a Home panel (INLINE_QUIZ_SETUP_UPDATE, reused by
 * INLINE_UPLOAD_AND_SOURCES_UPDATE): "Filled in from your preferences.", the
 * QuizSetupFields prefilled from preferences with length 5, then "Start quiz"
 * and the panel's own way out (Cancel, Later). Mounted on each open, so each
 * open starts from the preferences again. "Start quiz" goes straight to Q1.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, SlidersHorizontal } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading } from "../components/Bits";
import { QuizSetupFields } from "../components/QuizSetupFields";
import type { Prefs, Quiz } from "../lib/quiz";
import { INLINE_DEFAULT_LENGTH, setupFromPrefs } from "../lib/setup";
import type { AsyncState } from "../lib/useAsync";
import { useStartQuiz, type StartTarget } from "../lib/useStartQuiz";

export type OnStarted = (quiz: Quiz, resumed: boolean) => void;

export function InlineSetup({
  target,
  prefs,
  onStarted,
  secondary,
}: {
  target: StartTarget;
  prefs: AsyncState<Prefs>;
  onStarted: OnStarted;
  /** The ghost button next to "Start quiz" (Cancel or Later). */
  secondary: ReactNode;
}) {
  return (
    <>
      <p className="flex items-center gap-1.5 text-meta text-muted">
        <SlidersHorizontal aria-hidden="true" className="shrink-0" />
        Filled in from your preferences.
      </p>
      {prefs.status === "ok" ? (
        <InlineSetupForm target={target} prefs={prefs.data} secondary={secondary} onStarted={onStarted} />
      ) : (
        <>
          {prefs.status === "loading" ? <Loading /> : <ErrorNotice>{prefs.message}</ErrorNotice>}
          <div>{secondary}</div>
        </>
      )}
    </>
  );
}

function InlineSetupForm({
  target,
  prefs,
  secondary,
  onStarted,
}: {
  target: StartTarget;
  prefs: Prefs;
  secondary: ReactNode;
  onStarted: OnStarted;
}) {
  const [values, setValues] = useState(() => setupFromPrefs(prefs, INLINE_DEFAULT_LENGTH));
  const { start, starting, error } = useStartQuiz(target, onStarted);
  const form = useRef<HTMLFormElement>(null);

  // Opened: focus the chosen Difficulty option (Tab and arrow keys go on from there).
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);

  return (
    <form
      ref={form}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void start(values);
      }}
    >
      <QuizSetupFields values={values} onChange={setValues} showFormats />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="submit" size="lg" disabled={starting} aria-busy={starting}>
          {starting ? "Starting…" : "Start quiz"}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
        {secondary}
      </div>
    </form>
  );
}

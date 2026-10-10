import { useState } from "react";
import { Info, X } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading, Tag } from "../components/Bits";
import { questionEnter } from "../lib/motion";
import { navigate } from "../lib/router";
import { MODE_LABEL, citationFor, difficultyLabel, quizTitle, type Quiz, type QuizResult } from "../lib/quiz";
import { OptionList } from "../quiz/OptionList";
import { RevealPanel } from "../quiz/RevealPanel";
import { useActiveQuiz } from "../quiz/useActiveQuiz";
import { optionsPhaseOf, useQuizRunner } from "../quiz/useQuizRunner";

/**
 * The question screen (layout C, "Split"). Loads the quiz in progress (or takes
 * the one just started), then runs one question at a time. The state machine,
 * server calls, keyboard and focus live in useQuizRunner; this file is the view.
 */
export function QuizScreen({
  started,
  onFinished,
  onLeave,
}: {
  /** The quiz just started from setup, if any; otherwise the quiz in progress is fetched. */
  started: Quiz | null;
  onFinished: (result: QuizResult) => void;
  onLeave: () => void;
}) {
  const { state: load, reload, gone } = useActiveQuiz(started);

  if (load.status === "loading") return <Loading label="Loading your quiz" />;
  if (load.status === "error" || load.status === "gone") {
    return (
      <div className="flex max-w-[560px] flex-col gap-4 pt-3">
        <ErrorNotice>{load.message}</ErrorNotice>
        <div className="flex flex-wrap gap-2.5">
          {load.status === "error" && (
            <Button onClick={reload}>Try again</Button>
          )}
          <Button variant="secondary" onClick={() => navigate({ name: "home" })}>
            Home
          </Button>
        </div>
      </div>
    );
  }
  return (
    <QuizRunner
      key={load.quiz.quizId}
      quiz={load.quiz}
      onFinished={onFinished}
      onLeave={onLeave}
      onResync={reload}
      onGone={gone}
    />
  );
}

function QuizRunner({
  quiz,
  onFinished,
  onLeave,
  onResync,
  onGone,
}: {
  quiz: Quiz;
  onFinished: (result: QuizResult) => void;
  onLeave: () => void;
  onResync: () => void;
  onGone: (message: string) => void;
}) {
  const {
    index,
    phase,
    question,
    answer,
    isLast,
    practice,
    selected,
    shownPick,
    correctIndex,
    error,
    announcement,
    headingRef,
    nextRef,
    panelRef,
    optionRefs,
    select,
    submit,
    advance,
    finish,
  } = useQuizRunner(quiz, { onFinished, onResync, onGone });

  const reduce = useReducedMotion();
  // The question the screen opened on appears in place; each next one slides in.
  const [firstIndex] = useState(index);
  const optionsPhase = optionsPhaseOf(phase);
  const pad = (n: number) => String(n).padStart(2, "0");
  const category = quizTitle(quiz);
  // A review quiz is as long as the misses waiting; being shorter is not news.
  // A category or source pool at one difficulty can run short (STM-8, STM-23).
  const short = quiz.kind !== "review" && quiz.difficulty !== null && quiz.questionCount < quiz.length;

  return (
    <div className="flex max-w-[720px] flex-col gap-4.5 pt-1 md:max-w-[1080px]">
      <div className="flex items-center gap-2.5">
        <Button variant="secondary" className="size-11 shrink-0 px-0" aria-label="Leave quiz" onClick={onLeave}>
          <X aria-hidden="true" className="size-4.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui">{category}</p>
          <p className="text-meta text-muted">
            {difficultyLabel(quiz.difficulty)}, {MODE_LABEL[quiz.mode]} mode
          </p>
        </div>
      </div>

      {short && index === 0 && (phase === "answering" || phase === "checking") && (
        <div className="flex gap-3 rounded-md bg-neutral-900 px-4 py-3.5 shadow-sm">
          <Info aria-hidden="true" className="size-5.5 shrink-0 text-accent" />
          <p className="text-small text-pretty">
            <span className="block text-ui">A shorter quiz this time.</span>
            <span className="text-muted">
              There are only {quiz.questionCount} {difficultyLabel(quiz.difficulty).toLowerCase()} questions so far,
              so this quiz has {quiz.questionCount} instead of {quiz.length}.
            </span>
          </p>
        </div>
      )}

      <motion.div
        key={index}
        initial={reduce || index === firstIndex ? false : questionEnter.initial}
        animate={questionEnter.animate}
        transition={questionEnter.transition}
        className="grid grid-cols-1 items-start gap-4.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] md:gap-9"
      >
        <div className="flex flex-col gap-3.5 md:pt-2">
          <p className="text-counter leading-none font-medium tracking-[-0.03em] text-neutral-600">
            <span className="sr-only">
              Question {index + 1} of {quiz.questionCount}
            </span>
            <span aria-hidden="true">
              <span className="text-accent">{pad(index + 1)}</span> / {pad(quiz.questionCount)}
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {question.topic && <Tag tone="accent">{question.topic}</Tag>}
            <Tag tone="neutral">Multiple choice</Tag>
          </div>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-q-phone leading-[1.25] text-pretty outline-none md:text-q"
          >
            {question.prompt}
          </h1>
        </div>

        <div className="flex flex-col gap-4 rounded-lg bg-surface p-4 shadow-sm sm:p-5.5">
          <OptionList
            name={`q${index}`}
            options={question.options}
            phase={optionsPhase}
            selected={shownPick}
            correctIndex={correctIndex}
            onSelect={select}
            inputRefs={optionRefs}
          />

          {error && (
            <ErrorNotice
              action={
                phase === "finish-failed" ? (
                  <Button variant="secondary" onClick={() => void finish()}>
                    Try again
                  </Button>
                ) : undefined
              }
            >
              {error}
            </ErrorNotice>
          )}

          {phase === "answering" && (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" disabled={selected === null} onClick={() => void submit()}>
                {practice ? "Check answer" : "Lock it in"}
              </Button>
              <span className="hidden text-meta text-muted sm:inline">Press 1–4 to pick, Enter to check</span>
            </div>
          )}

          {(phase === "checking" || phase === "finishing") && (
            <Checking label={phase === "finishing" ? "Adding it up" : practice ? "Let’s see" : "Saving"} />
          )}

          {phase === "revealed" && answer && (
            <RevealPanel
              correct={answer.correct === true}
              explanation={answer.explanation ?? ""}
              citation={citationFor(quiz, question.topic)}
              index={index}
              isLast={isLast}
              onNext={advance}
              nextRef={nextRef}
              panelRef={panelRef}
            />
          )}
        </div>
      </motion.div>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

/** Three bouncing dots and a word. The dots stop under reduced motion. */
function Checking({ label }: { label: string }) {
  return (
    <div className="flex min-h-12 items-center gap-2.5 text-ui text-accent-300" aria-busy="true">
      <span aria-hidden="true" className="flex gap-1">
        <span className="size-1.5 animate-dot rounded-full bg-accent" />
        <span className="size-1.5 animate-dot rounded-full bg-accent [animation-delay:0.15s]" />
        <span className="size-1.5 animate-dot rounded-full bg-accent [animation-delay:0.3s]" />
      </span>
      {label}
    </div>
  );
}

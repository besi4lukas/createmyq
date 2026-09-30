import { useCallback, useEffect, useRef, useState } from "react";
import { Info, X } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading, Tag } from "../components/Bits";
import { ApiError } from "../lib/api";
import { navigate } from "../lib/router";
import {
  DIFFICULTY_LABEL,
  MODE_LABEL,
  categoryName,
  finishQuiz,
  friendlyError,
  getActiveQuiz,
  submitAnswer,
  type Answer,
  type Quiz,
  type QuizResult,
} from "../lib/quiz";
import { OptionList, type OptionsPhase } from "../quiz/OptionList";
import { RevealPanel } from "../quiz/RevealPanel";
import { useQuizKeys } from "../quiz/useQuizKeys";

/**
 * Practice holds a short beat between choosing and the verdict: the pause is
 * part of the design ("Let's see"). Exam has no verdict, so it doesn't wait.
 */
const PRACTICE_PAUSE_MS = 700;

type Phase =
  | "answering" // picking an option
  | "checking" // the answer is on its way to the Durable Object
  | "revealed" // Practice: verdict and explanation are showing
  | "finishing" // the last answer is in; asking for the score
  | "finish-failed"; // finishing failed; retry offered

type Load =
  | { status: "loading" }
  | { status: "ready"; quiz: Quiz }
  | { status: "error"; message: string }
  | { status: "gone"; message: string };

/**
 * The question screen (layout C, "Split"). Loads the quiz in progress (or takes
 * the one just started), then runs one question at a time. Every answer is
 * written to the user's Durable Object before the screen moves on, so a refresh
 * resumes at the first unanswered question with every answer intact.
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
  const [load, setLoad] = useState<Load>(started ? { status: "ready", quiz: started } : { status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (started && attempt === 0) return;
    let cancelled = false;
    getActiveQuiz()
      .then((quiz) => {
        if (cancelled) return;
        if (quiz) setLoad({ status: "ready", quiz });
        else navigate({ name: "home" }, { replace: true });
      })
      .catch((err: unknown) => !cancelled && setLoad({ status: "error", message: friendlyError(err) }));
    return () => {
      cancelled = true;
    };
  }, [started, attempt]);

  // Fetch the quiz in progress again, from scratch (retry, or catching up with the server).
  function reload() {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }

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
      onGone={(message) => setLoad({ status: "gone", message })}
    />
  );
}

/** Where to pick up: the first unanswered question, or the end if all are answered. */
function startingPoint(quiz: Quiz): { index: number; phase: Phase } {
  const last = quiz.questionCount - 1;
  if (quiz.currentIndex <= last) return { index: quiz.currentIndex, phase: "answering" };
  // Every question answered but not finished (e.g. a refresh on the last verdict).
  return { index: last, phase: quiz.mode === "practice" ? "revealed" : "finishing" };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const start = startingPoint(quiz);
  const [index, setIndex] = useState(start.index);
  const [phase, setPhase] = useState<Phase>(start.phase);
  const [selected, setSelected] = useState<number | null>(null);
  const [answers, setAnswers] = useState<(Answer | undefined)[]>(() => quiz.answers.slice());
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const busy = useRef(false);
  const mounted = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const question = quiz.questions[index]!;
  const answer = answers[index];
  const isLast = index === quiz.questionCount - 1;
  const practice = quiz.mode === "practice";

  /** Ask for the score. The caller has already put the screen in "finishing". */
  const requestFinish = useCallback(async () => {
    try {
      const result = await finishQuiz(quiz.quizId);
      if (mounted.current) onFinished(result);
    } catch (err) {
      if (!mounted.current) return;
      setError(friendlyError(err));
      setPhase("finish-failed");
    }
  }, [quiz.quizId, onFinished]);

  function finish() {
    setPhase("finishing");
    setError(null);
    return requestFinish();
  }

  // Resumed with every answer in (Exam): nothing left to show, so finish.
  useEffect(() => {
    if (start.phase === "finishing") void requestFinish();
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new question: start at the top, and move focus to the question so screen
  // readers read it and Tab lands on the options next.
  useEffect(() => {
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
  }, [index]);

  // The verdict is in: bring it into view and focus "Next question". Instant on
  // purpose: a smooth scroll is motion (STM-26) and can stall (rAF is paused in a
  // background tab), which would leave the button below the fold.
  useEffect(() => {
    if (phase !== "revealed") return;
    panelRef.current?.scrollIntoView({ block: "nearest" });
    nextRef.current?.focus();
  }, [phase]);

  function select(option: number) {
    if (phase !== "answering" || option >= question.options.length) return;
    setSelected(option);
    setError(null);
    optionRefs.current[option]?.focus();
  }

  async function submit() {
    if (phase !== "answering" || selected === null || busy.current) return;
    busy.current = true;
    setPhase("checking");
    setError(null);
    const began = Date.now();
    try {
      const out = await submitAnswer(quiz.quizId, index, selected);
      if (!mounted.current) return;
      setAnswers((prev) => {
        const next = prev.slice();
        next[index] = out.answer;
        return next;
      });
      if (practice) {
        await wait(PRACTICE_PAUSE_MS - (Date.now() - began));
        if (!mounted.current) return;
        const right = out.answer.correct === true;
        setAnnouncement(
          right ? "Correct." : `Not quite. The answer is: ${out.answer.correctAnswer ?? ""}`,
        );
        setPhase("revealed");
      } else if (out.done) {
        setAnnouncement("Answer saved.");
        await finish();
      } else {
        setAnnouncement("Answer saved.");
        goTo(index + 1);
      }
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.code === "out_of_order") {
        // Answered elsewhere (another tab): catch up with the server.
        onResync();
        return;
      }
      if (err instanceof ApiError && (err.code === "not_current_quiz" || err.code === "no_quiz")) {
        onGone("This quiz is no longer in progress. It may have been finished in another tab.");
        return;
      }
      setError(`${friendlyError(err)} Your pick is still selected, so you can send it again.`);
      setPhase("answering");
    } finally {
      busy.current = false;
    }
  }

  function goTo(next: number) {
    setIndex(next);
    setSelected(null);
    setPhase("answering");
  }

  function advance() {
    if (phase !== "revealed") return;
    if (isLast) void finish();
    else goTo(index + 1);
  }

  useQuizKeys({
    onNumber: select,
    onEnter: () => {
      if (phase === "answering") void submit();
      else if (phase === "revealed") advance();
    },
  });

  const optionsPhase: OptionsPhase =
    phase === "answering" ? "answering" : phase === "checking" ? "checking" : phase === "revealed" ? "revealed" : "locked";
  const shownPick = phase === "answering" || phase === "checking" ? selected : (answer?.option ?? null);
  const correctIndex =
    phase === "revealed" && answer?.correctAnswer !== undefined
      ? question.options.indexOf(answer.correctAnswer)
      : null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const category = categoryName(quiz.category);
  const short = quiz.questionCount < quiz.length;

  return (
    <div className="flex max-w-[720px] flex-col gap-4.5 pt-1 md:max-w-[1080px]">
      <div className="flex items-center gap-2.5">
        <Button variant="secondary" className="size-11 shrink-0 px-0" aria-label="Leave quiz" onClick={onLeave}>
          <X aria-hidden="true" className="size-4.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui">{category}</p>
          <p className="text-meta text-muted">
            {DIFFICULTY_LABEL[quiz.difficulty]}, {MODE_LABEL[quiz.mode]} mode
          </p>
        </div>
      </div>

      {short && index === 0 && (phase === "answering" || phase === "checking") && (
        <div className="flex gap-3 rounded-md bg-neutral-900 px-4 py-3.5 shadow-sm">
          <Info aria-hidden="true" className="size-5.5 shrink-0 text-accent" />
          <p className="text-small text-pretty">
            <span className="block text-ui">A shorter quiz this time.</span>
            <span className="text-muted">
              There are only {quiz.questionCount} {DIFFICULTY_LABEL[quiz.difficulty].toLowerCase()} questions so far,
              so this quiz has {quiz.questionCount} instead of {quiz.length}.
            </span>
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] md:gap-9">
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
              citation={question.topic ? `${category} / ${question.topic}` : category}
              index={index}
              isLast={isLast}
              onNext={advance}
              nextRef={nextRef}
              panelRef={panelRef}
            />
          )}
        </div>
      </div>

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

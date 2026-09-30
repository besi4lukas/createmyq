import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, friendlyError } from "../lib/api";
import { finishQuiz, submitAnswer, type Answer, type Quiz, type QuizResult } from "../lib/quiz";
import type { OptionsPhase } from "./OptionList";
import { useQuizKeys } from "./useQuizKeys";

/**
 * Practice holds a short beat between choosing and the verdict: the pause is
 * part of the design ("Let's see"). Exam has no verdict, so it doesn't wait.
 */
const PRACTICE_PAUSE_MS = 700;

export type Phase =
  | "answering" // picking an option
  | "checking" // the answer is on its way to the Durable Object
  | "revealed" // Practice: verdict and explanation are showing
  | "finishing" // the last answer is in; asking for the score
  | "finish-failed"; // finishing failed; retry offered

/** Where to pick up: the first unanswered question, or the end if all are answered. */
export function startingPoint(quiz: Quiz): { index: number; phase: Phase } {
  const last = quiz.questionCount - 1;
  if (quiz.currentIndex <= last) return { index: quiz.currentIndex, phase: "answering" };
  // Every question answered but not finished (e.g. a refresh on the last verdict).
  return { index: last, phase: quiz.mode === "practice" ? "revealed" : "finishing" };
}

/** How the option list should look in each phase. */
export function optionsPhaseOf(phase: Phase): OptionsPhase {
  return phase === "answering" || phase === "checking" || phase === "revealed" ? phase : "locked";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One quiz, one question at a time: the phase machine, the calls to the
 * server, the keyboard (1-4 pick, Enter checks or moves on) and focus. Every
 * answer is written to the user's Durable Object before the screen moves on,
 * so a refresh resumes at the first unanswered question with every answer intact.
 */
export function useQuizRunner(
  quiz: Quiz,
  {
    onFinished,
    onResync,
    onGone,
  }: {
    onFinished: (result: QuizResult) => void;
    /** Answered elsewhere (another tab): fetch the quiz again. */
    onResync: () => void;
    /** The quiz is no longer in progress. */
    onGone: (message: string) => void;
  },
) {
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
        setAnnouncement(right ? "Correct." : `Not quite. The answer is: ${out.answer.correctAnswer ?? ""}`);
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

  // What the view shows.
  const shownPick = phase === "answering" || phase === "checking" ? selected : (answer?.option ?? null);
  const correctIndex =
    phase === "revealed" && answer?.correctAnswer !== undefined ? question.options.indexOf(answer.correctAnswer) : null;

  return {
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
  };
}

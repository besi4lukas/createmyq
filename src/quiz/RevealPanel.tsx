import type { Ref } from "react";
import { ArrowRight, BookOpenText, CheckCircle, XCircle } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/Button";
import { revealEnter } from "../lib/motion";

const LINES = {
  correct: ["Nailed it.", "Clean. That’s the one.", "Yep, exactly right.", "Textbook."],
  wrong: ["Close, but not this one.", "Tricky one. Here’s the catch.", "Not quite. Worth a second look."],
};

/**
 * Practice mode's verdict after each question (FR-16/17): icon + label, a
 * playful line, the explanation, where it comes from, and the way on.
 */
export function RevealPanel({
  correct,
  explanation,
  citation,
  index,
  isLast,
  onNext,
  nextRef,
  panelRef,
}: {
  correct: boolean;
  explanation: string;
  /** Where the question comes from ("System Design / Caching"); null shows no line. */
  citation: string | null;
  index: number;
  isLast: boolean;
  onNext: () => void;
  nextRef: Ref<HTMLButtonElement>;
  panelRef: Ref<HTMLDivElement>;
}) {
  const lines = correct ? LINES.correct : LINES.wrong;
  const Icon = correct ? CheckCircle : XCircle;
  const reduce = useReducedMotion();
  return (
    <motion.div
      ref={panelRef}
      initial={reduce ? false : revealEnter.initial}
      animate={revealEnter.animate}
      transition={revealEnter.transition}
      className={`flex flex-col gap-3.5 rounded-panel border p-4.5 ${
        correct ? "border-accent-600 bg-accent-900" : "border-wrong-bd bg-wrong-bg"
      }`}
    >
      <div className="flex items-center gap-3">
        <Icon
          aria-hidden="true"
          weight="fill"
          className={`size-7.5 shrink-0 ${correct ? "text-accent-300" : "text-wrong"}`}
        />
        <div>
          <p className={`text-title font-medium ${correct ? "text-accent-300" : "text-wrong"}`}>
            {correct ? "Correct" : "Not quite"}
          </p>
          <p className="text-small text-neutral-300">{lines[index % lines.length]}</p>
        </div>
      </div>
      <p className="text-ui text-pretty">{explanation}</p>
      {citation && (
        <p className="flex items-center gap-1.5 text-meta text-neutral-400">
          <BookOpenText aria-hidden="true" className="shrink-0" />
          {citation}
        </p>
      )}
      <div>
        <Button ref={nextRef} size="lg" onClick={onNext}>
          {isLast ? "See results" : "Next question"}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </motion.div>
  );
}

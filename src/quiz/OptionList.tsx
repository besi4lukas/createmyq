import type { RefObject } from "react";
import { Check, X } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { optionVariants } from "../lib/motion";

export type OptionsPhase = "answering" | "checking" | "revealed" | "locked";

type OptionState = "idle" | "selected" | "faded" | "right" | "wrong" | "dimmed";

/**
 * Multiple-choice options as a native radio group: Tab enters it once, arrow
 * keys move and select, and screen readers announce "radio, 2 of 4".
 *
 * Right and wrong are never colour alone: the badge swaps its letter for a
 * check or a cross, and a text label says "Correct answer" / "Your answer".
 * Motion (STM-26): on reveal the right option pops and a wrong pick shakes
 * (transform only, once each, skipped under reduced motion).
 */
export function OptionList({
  name,
  options,
  phase,
  selected,
  correctIndex,
  onSelect,
  inputRefs,
}: {
  name: string;
  options: string[];
  phase: OptionsPhase;
  /** The pick: the local selection while answering, the stored answer once revealed. */
  selected: number | null;
  /** Known only in Practice, once the answer is revealed. */
  correctIndex: number | null;
  onSelect: (index: number) => void;
  inputRefs: RefObject<(HTMLInputElement | null)[]>;
}) {
  const revealed = phase === "revealed" && correctIndex !== null;
  const reduce = useReducedMotion();

  function stateOf(i: number): OptionState {
    const chosen = selected === i;
    if (revealed) {
      if (i === correctIndex) return "right";
      if (chosen) return "wrong";
      return "dimmed";
    }
    if (chosen) return "selected";
    if (phase === "checking" || phase === "locked") return "faded";
    return "idle";
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-2.5">
      <legend className="sr-only">Answer options</legend>
      {options.map((label, i) => {
        const state = stateOf(i);
        const chosen = selected === i;
        return (
          <motion.label
            key={i}
            variants={optionVariants}
            animate={!reduce && (state === "right" || state === "wrong") ? state : undefined}
            className={`flex min-h-[54px] w-full items-center gap-3 rounded-md border px-3.5 py-3 text-left text-body leading-[1.35] transition-opacity duration-350 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent ${ROW[state]}`}
          >
            <input
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              type="radio"
              name={name}
              className="sr-only"
              checked={chosen}
              disabled={phase !== "answering"}
              onChange={() => onSelect(i)}
              aria-describedby={state === "right" || state === "wrong" ? `${name}-tag-${i}` : undefined}
            />
            <span
              aria-hidden="true"
              className={`grid size-7 shrink-0 place-items-center rounded-badge border text-meta font-semibold ${BADGE[state]}`}
            >
              {state === "right" ? (
                <Check weight="bold" className="size-4" />
              ) : state === "wrong" ? (
                <X weight="bold" className="size-4" />
              ) : (
                String.fromCharCode(65 + i)
              )}
            </span>
            <span className="flex-1">{label}</span>
            {(state === "right" || state === "wrong") && (
              <span
                id={`${name}-tag-${i}`}
                className={`max-w-16 text-right text-tag sm:max-w-none sm:whitespace-nowrap ${state === "right" ? "text-accent-300" : "text-wrong"}`}
              >
                {state === "right" ? (chosen ? "Your answer, correct" : "Correct answer") : "Your answer"}
              </span>
            )}
          </motion.label>
        );
      })}
    </fieldset>
  );
}

const ROW: Record<OptionState, string> = {
  idle: "border-divider bg-bg hover:border-text/45",
  selected: "border-accent bg-accent/13",
  faded: "border-divider bg-bg opacity-50",
  right: "border-accent-500 bg-accent-900",
  wrong: "border-wrong-bd bg-wrong-bg",
  dimmed: "border-divider bg-bg opacity-45",
};

const BADGE: Record<OptionState, string> = {
  idle: "border-neutral-600 text-neutral-300",
  selected: "border-accent bg-accent text-bg",
  faded: "border-neutral-600 text-neutral-300",
  right: "border-accent-500 bg-accent-800 text-accent-300",
  wrong: "border-wrong-bd bg-wrong-bg text-wrong",
  dimmed: "border-neutral-600 text-neutral-300",
};

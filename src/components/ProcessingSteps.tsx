/**
 * The six processing steps (design v2, screen 6), as derived in
 * src/lib/steps.ts from what the run has written so far. Shared by the
 * source status page and Home's inline upload card and source rows
 * (`compact`). Each step's state is said in words for screen readers and
 * shown by icon, never by colour alone. The spinner is the only motion, and
 * the reduced-motion guard in index.css stops it.
 */
import { CheckCircle, Circle, CircleNotch, MinusCircle, XCircle, type Icon } from "@phosphor-icons/react";
import { processingSteps, type StepInput, type StepState } from "../lib/steps";

const STATE: Record<StepState, { icon: Icon; weight?: "fill"; className: string; said: string }> = {
  done: { icon: CheckCircle, weight: "fill", className: "text-accent", said: "Done" },
  running: { icon: CircleNotch, className: "animate-spin text-accent-300", said: "In progress" },
  pending: { icon: Circle, className: "text-neutral-600 opacity-45", said: "Waiting" },
  skipped: { icon: MinusCircle, className: "text-neutral-600 opacity-45", said: "Skipped" },
  failed: { icon: XCircle, weight: "fill", className: "text-wrong", said: "Stopped here" },
};

export function ProcessingSteps({ source, compact = false }: { source: StepInput; compact?: boolean }) {
  const steps = processingSteps(source);
  return (
    <ol aria-label="Progress" className="flex flex-col">
      {steps.map((step) => {
        const s = STATE[step.state];
        const Glyph = s.icon;
        const dim = step.state === "pending" || step.state === "skipped";
        return (
          <li
            key={step.key}
            className={`flex transition-opacity duration-400 ${compact ? "gap-3 py-[7px]" : "gap-3.5 py-3"} ${dim ? "opacity-70" : ""}`}
          >
            <Glyph
              aria-hidden="true"
              weight={s.weight}
              className={`mt-px shrink-0 ${compact ? "size-4.5" : "size-5.5"} ${s.className}`}
            />
            <div className="min-w-0 flex-1">
              <div className={compact ? "text-small" : "text-ui"}>
                {step.label}
                <span className="sr-only">: {s.said}</span>
              </div>
              <div className="text-meta text-muted text-pretty">{step.description}</div>
            </div>
            {step.meta && <span className="text-meta text-muted">{step.meta}</span>}
          </li>
        );
      })}
    </ol>
  );
}

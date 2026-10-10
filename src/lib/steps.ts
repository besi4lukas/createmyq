/**
 * The six processing steps (design v2, screen 6) for one source, derived only
 * from what the run has written to Postgres (worker/sources/own-source.ts).
 * Pure.
 *
 * What the server can honestly report: the Workflow binding gives an
 * instance's overall status, not which step it is on, so the steps come from
 * the source row instead:
 *   uploaded                      queued: Claiming is next (running)
 *   processing, no fingerprint    claimed: Reading (extract, the long part)
 *   fingerprinted, no gate        Checking the subject (the lock, spend
 *                                 reservation and chunking happen here too)
 *   gate accepted, not ready      Writing questions; Quality check stays
 *                                 pending, because the row says nothing until
 *                                 the bank is stored, so it is never shown
 *                                 done (or running) before it is known
 *   ready                         all done
 * A step is shown done only once a later write proves it returned. A cache
 * hit (a duplicate of an existing bank) skips 4 to 6, as the design says.
 */
import type { Source } from "./sources";

export type StepState = "done" | "running" | "pending" | "skipped" | "failed";
export type StepKey = "claim" | "read" | "fingerprint" | "subject" | "write" | "quality";
export type Step = { key: StepKey; label: string; description: string; state: StepState; meta?: string };

export const STEPS: readonly { key: StepKey; label: string; description: string }[] = [
  { key: "claim", label: "Claiming", description: "Making sure nobody else is processing this right now" },
  { key: "read", label: "Reading", description: "Pulling the plain text out" },
  { key: "fingerprint", label: "Fingerprinting", description: "Checking if we’ve seen this exact text before" },
  { key: "subject", label: "Checking the subject", description: "Sampling the start, middle and end to see if it’s software" },
  { key: "write", label: "Writing questions", description: "Aiming for 20 to 25, each pointing back to the text" },
  { key: "quality", label: "Quality check", description: "Dropping anything malformed, vague or duplicated" },
];

export const CACHE_HIT_DESCRIPTION = "Seen this before. Skipping straight to your quiz.";
export const REFUSED_DESCRIPTION = "This doesn’t look like software.";

export type StepInput = Pick<Source, "id" | "status" | "bankSourceId" | "fingerprinted" | "gateVerdict">;

/** A duplicate of another source's bank: this upload's own run stopped at the fingerprint. */
export const isCacheHit = (s: Pick<Source, "id" | "bankSourceId">) => s.bankSourceId !== s.id;

/**
 * Each step's state: `done` steps before index `at`, then `atState` at `at`,
 * then `rest` for the ones after.
 */
function line(at: number, atState: StepState, rest: StepState): StepState[] {
  return STEPS.map((_, i) => (i < at ? "done" : i === at ? atState : rest));
}

export function processingSteps(s: StepInput): Step[] {
  const cached = isCacheHit(s);
  let states: StepState[];
  switch (s.status) {
    case "uploaded":
      states = line(0, "running", "pending");
      break;
    case "processing":
    case "duplicate":
      if (!s.fingerprinted) states = line(1, "running", "pending");
      else if (s.gateVerdict === null) states = line(3, "running", "pending");
      else states = line(4, "running", "pending");
      break;
    case "ready":
      states = cached ? line(3, "skipped", "skipped") : line(6, "done", "done");
      break;
    case "refused":
      states = line(3, "failed", "skipped");
      break;
    case "failed":
      if (!s.fingerprinted) states = line(1, "failed", "skipped");
      else if (s.gateVerdict === null) states = line(3, "failed", "skipped");
      else states = line(4, "failed", "skipped");
      break;
    default:
      states = s.status satisfies never;
  }
  return STEPS.map((step, i) => {
    const out: Step = { ...step, state: states[i]! };
    if (cached && step.key === "fingerprint" && s.fingerprinted) {
      out.description = CACHE_HIT_DESCRIPTION;
      out.meta = "match";
    }
    if (step.key === "subject" && s.status === "refused") out.description = REFUSED_DESCRIPTION;
    return out;
  });
}

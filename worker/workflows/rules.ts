/**
 * STM-15: the pure rules of the generation run. No I/O; the Workflow
 * (generation.ts) and the queue consumer (queue.ts) call these.
 */
import type { sourceStatus } from "../db/schema";

export type SourceStatus = (typeof sourceStatus.enumValues)[number];

/** The statuses the Workflow writes. ready / refused arrive with STM-18 and STM-22. */
export type RunStatus = "processing" | "failed" | "duplicate";

/**
 * Where each status may be entered from. The UPDATE in generation.ts only
 * matches rows in one of these, so a stale or repeated run never overwrites a
 * finished source.
 *
 * processing: from uploaded (first run) or processing (the step re-ran).
 * failed:     only from processing, so a run never fails someone else's result.
 * duplicate:  from processing (the fingerprint step) or duplicate (it re-ran).
 *
 * The one other move, failed → processing when a later upload retries a bank,
 * is made only by the lock holder (lock-rules.ts: mayReopen).
 */
const ALLOWED_FROM: Record<RunStatus, SourceStatus[]> = {
  processing: ["uploaded", "processing"],
  failed: ["processing"],
  duplicate: ["processing", "duplicate"],
};

export function allowedFrom(to: RunStatus): SourceStatus[] {
  return ALLOWED_FROM[to];
}

/**
 * One run per source, ever (until the Workflow's retention expires): the
 * queue may deliver a message twice, and create() refuses an id it has seen.
 */
export function instanceIdFor(sourceId: string): string {
  return `source-${sourceId}`;
}

/**
 * The extracted text is handed to later steps as the Extract step's return
 * value, which Workflows caps at 1 MiB. Strings may be stored as UTF-16 (two
 * bytes a char), so 500,000 chars is 1,000,000 bytes at worst, leaving room for
 * the fingerprint. A 50-page PDF is usually 15–60 KB of text, an 80-minute
 * video about 70 KB.
 */
export const MAX_TEXT_CHARS = 500_000;

export function fitsInStepResult(text: string): boolean {
  return text.length <= MAX_TEXT_CHARS;
}

// User-facing messages, stored in sources.error.
export const TOO_MUCH_TEXT = "This source has too much text for one quiz. Try a shorter one.";
export const GENERATION_FAILED = "Something went wrong while making your quiz. Please upload the file again.";
// TODO(STM-18): remove once generation is real. The run ends here for now, so
// the user sees a clear message instead of a source that is never ready.
export const GENERATION_NOT_LIVE = "Making quizzes from your own files is not switched on yet.";

/** TODO(STM-18): replace with real generation. Deterministic, no model calls. */
export function stubQuestions(fingerprint: string, count = 20): { stem: string }[] {
  return Array.from({ length: count }, (_, i) => ({ stem: `Stub question ${i + 1} for ${fingerprint.slice(0, 8)}` }));
}

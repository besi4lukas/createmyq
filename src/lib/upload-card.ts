/**
 * Home's inline upload card and saved-source rows
 * (INLINE_UPLOAD_AND_SOURCES_UPDATE): which phase the card is in, and the
 * copy each phase shows. Pure: the card component holds the job id and the
 * timer, the server holds the job's status.
 */
import { isWorking, type Source, type Usage } from "./sources";
import { isCacheHit } from "./steps";

export type CardPhase = "form" | "processing" | "refused" | "failed" | "setup";

/** How long the finished step list stays up before the card moves on to setup by itself. */
export const READY_PAUSE_MS = 700;

/**
 * The card's phase. No job: the form. A job whose status hasn't loaded yet,
 * or is still working: processing. Ready: processing for READY_PAUSE_MS
 * (`readyPaused`), then setup.
 */
export function cardPhase(job: string | null, source: Source | undefined, readyPaused: boolean): CardPhase {
  if (job === null) return "form";
  if (!source || isWorking(source.status)) return "processing";
  switch (source.status) {
    case "ready":
      return readyPaused ? "processing" : "setup";
    case "refused":
      return "refused";
    case "failed":
      return "failed";
    default:
      return "processing";
  }
}

export const FORM_SUBTITLE = "Anything about software engineering. We’ll check it’s on topic and write 20 to 25 questions.";

export function cardTitle(phase: CardPhase, source: Source | undefined): string {
  switch (phase) {
    case "form":
      return "Bring your own material";
    case "processing":
      return source && source.fingerprinted && isCacheHit(source) ? "We’ve seen this one" : "Making your quiz";
    case "refused":
    case "failed":
      return "Couldn’t use this one";
    case "setup":
      return "Your quiz is ready";
    default:
      return phase satisfies never;
  }
}

/** What a source is called on screen: its title (the file name, the link), else its url. */
export function sourceName(s: Pick<Source, "title" | "url"> | undefined, fallback = "Your source"): string {
  return s?.title ?? s?.url ?? fallback;
}

const questions = (n: number) => `${n} ${n === 1 ? "question" : "questions"}`;

/**
 * The success banner over the setup. The design's "4 were dropped in the
 * quality check" is left out: the run logs that number but stores nowhere, so
 * the banner says only what is known. The cache-hit line is true: a run that
 * stops at the fingerprint gives its daily-cap count back (STM-24).
 */
export function readyBanner(s: Pick<Source, "id" | "bankSourceId" | "questionCount">): { lead: string; body: string } {
  return isCacheHit(s)
    ? {
        lead: `${questions(s.questionCount)}, ready now.`,
        body: "Someone in the group brought the same text. Nothing had to be generated, and it didn’t count toward your limit.",
      }
    : {
        lead: `${questions(s.questionCount)} made.`,
        body: "Every one points back to the part of the text it came from.",
      };
}

/** "2 of 3 sources used today". The cap is the server's (3 unless configured), not the design's 5. */
export const usageLabel = (u: Usage) => `${Math.min(u.used, u.limit)} of ${u.limit} sources used today`;

export const isCapped = (u: Usage) => u.used >= u.limit;

/** The muted line under a saved source's name. No middots: commas only. */
export function rowMeta(s: Pick<Source, "status" | "questionCount" | "visibility">): string {
  switch (s.status) {
    case "ready":
      return `${questions(s.questionCount)}, ${s.visibility === "group" ? "shared with the group" : "private"}`;
    case "uploaded":
    case "processing":
    case "duplicate":
      return "Working on it";
    case "refused":
      return "Not about software engineering";
    case "failed":
      return "Didn’t work";
    default:
      return s.status satisfies never;
  }
}

/** 0.94 → 94. Null when the gate stored no confidence. */
export const confidencePercent = (c: number | null) => (c === null ? null : Math.round(c * 100));

/**
 * The stored off-topic message (CLAUDE.md: "This looks like {detected}.
 * CreateMyQ only covers software engineering right now.") split around the
 * topic, so the topic can be shown in accent text while the sentence stays
 * exactly as stored. Null when the topic isn't in the message.
 */
export function splitOnTopic(message: string, topic: string | null): [string, string, string] | null {
  if (!topic) return null;
  const at = message.indexOf(topic);
  return at < 0 ? null : [message.slice(0, at), topic, message.slice(at + topic.length)];
}

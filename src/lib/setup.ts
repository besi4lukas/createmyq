/**
 * Quiz setup rules shared by the Setup page and the inline setup on Home's
 * category cards (QuizSetupFields). Pure: no React, no fetch.
 */
import type { Difficulty, Format, Mode, Prefs, QuizLength } from "./quiz";

/** What a setup form holds. `formats` is shown on Home only and is not sent: see FORMAT_AVAILABLE. */
export type SetupValues = {
  difficulty: Difficulty;
  length: QuizLength;
  mode: Mode;
  formats: Format[];
};

/** Every format in display order, and whether a quiz can serve it yet. */
export const FORMATS = ["multiple_choice", "short_answer"] as const satisfies readonly Format[];

export const FORMAT_LABEL: Record<Format, string> = {
  multiple_choice: "Multiple choice",
  short_answer: "Short answer",
};

/**
 * Short answer can't be generated, graded or served yet (its payload schema is
 * z.never), so it is shown switched off and can't be turned on. Quiz start
 * takes no formats either: every quiz is multiple choice today.
 */
export const FORMAT_AVAILABLE: Record<Format, boolean> = {
  multiple_choice: true,
  short_answer: false,
};

/** The saved formats a quiz can actually use, never none. */
export function availableFormats(saved: readonly Format[]): Format[] {
  const usable = FORMATS.filter((f) => saved.includes(f) && FORMAT_AVAILABLE[f]);
  return usable.length > 0 ? usable : ["multiple_choice"];
}

/**
 * Turn a format chip on or off. At least one format stays on, and a format
 * that isn't available can't be turned on. Returns the same array when
 * nothing changes.
 */
export function toggleFormat(formats: Format[], format: Format): Format[] {
  if (formats.includes(format)) {
    if (formats.length <= 1) return formats;
    return formats.filter((f) => f !== format);
  }
  if (!FORMAT_AVAILABLE[format]) return formats;
  return FORMATS.filter((f) => f === format || formats.includes(f));
}

/** The inline setup on Home always starts at 5 questions (INLINE_QUIZ_SETUP_UPDATE). */
export const INLINE_DEFAULT_LENGTH: QuizLength = 5;

/**
 * A setup form's starting values from the user's preferences. The Setup page
 * uses the saved length; Home's inline setup passes 5.
 */
export function setupFromPrefs(prefs: Prefs, length: QuizLength = prefs.defaultLength): SetupValues {
  return {
    difficulty: prefs.defaultDifficulty,
    length,
    mode: prefs.defaultMode,
    formats: availableFormats(prefs.formats),
  };
}

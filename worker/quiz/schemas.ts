/**
 * Zod schemas for quiz and preference input, shared by the routes (validation
 * at the edge) and the UserSession object (its last line of defence). Enum
 * values come from the Drizzle enums, so a mode or difficulty can't exist here
 * without existing in Postgres.
 */
import { z } from "zod";
import { sessionMode } from "../db/schema";
import { questionDifficultySchema, questionFormatSchema } from "../questions/payload";

/** A categories.slug as it appears in URLs and request bodies. */
export const categorySlugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const quizModeSchema = z.enum(sessionMode.enumValues);
export type QuizMode = z.infer<typeof quizModeSchema>;

/** Quiz lengths (FR-5), as JSON numbers. GET /api/quiz takes them as query strings (assemble.ts). */
export const quizLengthSchema = z.union([z.literal(5), z.literal(10), z.literal(20)]);

// ---------------------------------------------------------------------------
// Session routes (STM-9)
// ---------------------------------------------------------------------------

export const startBody = z.strictObject({
  category: categorySlugSchema,
  difficulty: questionDifficultySchema,
  length: quizLengthSchema,
  mode: quizModeSchema,
});

const quizId = z.uuid();

/** Index and option bounds: at most 20 questions of 4 options. The object re-checks against the quiz. */
export const answerBody = z.strictObject({
  quizId,
  index: z.number().int().min(0).max(19),
  option: z.number().int().min(0).max(3),
});

export const finishBody = z.strictObject({ quizId });

// ---------------------------------------------------------------------------
// Preferences (FR-23). STM-24 adds the daily generation counter next to these.
// ---------------------------------------------------------------------------

export const prefsSchema = z.strictObject({
  defaultDifficulty: questionDifficultySchema,
  defaultMode: quizModeSchema,
  defaultLength: quizLengthSchema,
  formats: z
    .array(questionFormatSchema)
    .min(1)
    .refine((f) => new Set(f).size === f.length, "duplicate format"),
});
export type Prefs = z.infer<typeof prefsSchema>;

/** PUT /api/prefs: any subset of the fields, merged over the current prefs. */
export const prefsPatchSchema = prefsSchema.partial();
export type PrefsPatch = z.infer<typeof prefsPatchSchema>;

export const DEFAULT_PREFS: Prefs = {
  defaultDifficulty: "beginner",
  defaultMode: "practice",
  defaultLength: 10,
  formats: ["multiple_choice"],
};

/** Stored prefs, or the defaults if nothing (or nothing valid) is stored. */
export function readPrefs(stored: unknown): Prefs {
  const parsed = prefsSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_PREFS;
}

/** `patch` merged over `current`. Throws on an invalid patch or result. */
export function mergePrefs(current: Prefs, patch: PrefsPatch): Prefs {
  return prefsSchema.parse({ ...current, ...prefsPatchSchema.parse(patch) });
}

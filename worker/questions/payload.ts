/**
 * Zod shapes for `questions.payload`, which is jsonb with a per-format shape
 * (see worker/db/schema.ts). Lives under worker/ because the Worker reads and
 * grades these payloads (STM-8 onwards); operator scripts in scripts/ import
 * it too, so the seed file and the API validate against the same rules.
 *
 * Enum values come from the Drizzle enums, so a format or difficulty can't
 * exist here without existing in Postgres.
 */
import { z } from "zod";
import { questionDifficulty, questionFormat } from "../db/schema";

/** A string with at least one non-whitespace character. Not trimmed. */
export const nonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");

export const questionFormatSchema = z.enum(questionFormat.enumValues);
export const questionDifficultySchema = z.enum(questionDifficulty.enumValues);

/**
 * Multiple choice: exactly four distinct, non-blank options, and `answer` is
 * the exact text of one of them. Options are compared after trimming, so two
 * options that differ only by surrounding whitespace count as duplicates.
 */
export const multipleChoicePayload = z
  .strictObject({
    options: z.array(nonBlank).length(4),
    answer: nonBlank,
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.options.forEach((option, i) => {
      const key = option.trim();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["options", i], message: "duplicate option" });
      }
      seen.add(key);
    });
    if (!p.options.includes(p.answer)) {
      ctx.addIssue({
        code: "custom",
        path: ["answer"],
        message: "must equal the exact text of one of the options",
      });
    }
  });

/**
 * Short answer is in the enum but out of scope for the beta (multiple choice
 * only; see TASKS.md "Short answer format and rubric grading"). Until that
 * ticket designs the payload, no short-answer payload is valid.
 */
export const shortAnswerPayload = z.never({
  error: "short_answer payloads are not defined yet (the beta ships multiple choice only)",
});

/** `{ format, payload }` checked together, discriminated by format. */
export const formatAndPayload = z.discriminatedUnion("format", [
  z.object({ format: z.literal("multiple_choice"), payload: multipleChoicePayload }),
  z.object({ format: z.literal("short_answer"), payload: shortAnswerPayload }),
]);

export type MultipleChoicePayload = z.infer<typeof multipleChoicePayload>;
export type FormatAndPayload = z.infer<typeof formatAndPayload>;

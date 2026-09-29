/**
 * Shape of a seed file such as seed/system-design.json: one category plus its
 * reviewed questions. Difficulty and format come from the file (they were set
 * by a human reviewer), not from the classifier.
 */
import { z } from "zod";
import {
  multipleChoicePayload,
  nonBlank,
  questionDifficultySchema,
  shortAnswerPayload,
} from "../worker/questions/payload";

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a lowercase-kebab slug");

const questionBase = z.strictObject({
  external_id: nonBlank,
  difficulty: questionDifficultySchema,
  topic: nonBlank,
  prompt: nonBlank,
  explanation: nonBlank,
});

export const seedQuestion = z.discriminatedUnion("format", [
  questionBase.extend({ format: z.literal("multiple_choice"), payload: multipleChoicePayload }),
  questionBase.extend({ format: z.literal("short_answer"), payload: shortAnswerPayload }),
]);

/**
 * Duplicate external_ids. `when: () => true` makes it run even when individual
 * questions already failed, so one run reports every problem; the input may
 * therefore be malformed and is read defensively.
 */
const uniqueExternalIds = z.superRefine<unknown>(
  (file, ctx) => {
    const questions = (file as { questions?: unknown } | null)?.questions;
    if (!Array.isArray(questions)) return;
    const firstIndex = new Map<string, number>();
    questions.forEach((q: unknown, i) => {
      const id = (q as { external_id?: unknown } | null)?.external_id;
      if (typeof id !== "string") return;
      const first = firstIndex.get(id);
      if (first === undefined) {
        firstIndex.set(id, i);
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["questions", i, "external_id"],
          message: `duplicate external_id (also questions[${first}])`,
        });
      }
    });
  },
  { when: () => true },
);

export const seedFile = z
  .strictObject({
    category: z.strictObject({ slug, name: nonBlank, niche: nonBlank }),
    questions: z.array(seedQuestion).min(1),
  })
  .check(uniqueExternalIds);

export type SeedFile = z.infer<typeof seedFile>;
export type SeedQuestion = z.infer<typeof seedQuestion>;

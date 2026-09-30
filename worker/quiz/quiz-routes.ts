/**
 * STM-8: a fresh quiz from the bank. Read-only; see worker/quiz/assemble.ts.
 *   GET /api/quiz?category=system-design&difficulty=beginner&length=10
 */
import { Hono } from "hono";
import type { AppEnv } from "../auth/session";
import { apiError } from "../http";
import { assembleQuery, pickQuestions, toPublicQuestion } from "./assemble";

export const quizRoutes = new Hono<AppEnv>();

quizRoutes.get("/quiz", async (c) => {
  const input = assembleQuery.safeParse(c.req.query());
  if (!input.success) {
    return apiError(c, 400, "Pick a category, a difficulty (beginner, intermediate or advanced) and a length of 5, 10 or 20.");
  }
  const { category, difficulty, length } = input.data;

  const picked = await pickQuestions(c.var.db, c.var.user.id, input.data);
  if (!picked.ok) return apiError(c, 404, picked.error);
  return c.json({
    category,
    difficulty,
    length,
    // true when the whole pool is smaller than the requested length (see assemble.ts)
    short: picked.questions.length < length,
    questions: picked.questions.map(toPublicQuestion),
  });
});

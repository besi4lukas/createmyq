/**
 * Quiz session and preference routes (STM-9). Thin: validate, then call the
 * signed-in user's UserSession Durable Object. The object is addressed by our
 * users.id from the verified session, never by anything the client sends, so a
 * user can only ever reach their own object.
 *
 *   POST /api/session          start a quiz (409 + the quiz if one is in progress)
 *   GET  /api/session          the quiz in progress, for resume ({ quiz: null } if none)
 *   POST /api/session/answer   { quizId, index, option } → graded in the object
 *   POST /api/session/finish   { quizId } → score + full review
 *   GET  /api/prefs, PUT /api/prefs
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/session";
import { prefsPatchSchema, quizLengthSchema, quizModeSchema } from "../durable/user-session";
import { questionDifficultySchema } from "../questions/payload";
import { assembleQuiz, findCategoryId } from "./assemble";

export const sessionRoutes = new Hono<AppEnv>();

const userSession = (c: Context<AppEnv>) =>
  c.env.USER_SESSION.get(c.env.USER_SESSION.idFromName(c.var.user.id));

/** The JSON body, or undefined if it isn't JSON (the schema then rejects it as 400). */
async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const startBody = z.strictObject({
  category: z.string().regex(/^[a-z0-9-]{1,64}$/),
  difficulty: questionDifficultySchema,
  length: quizLengthSchema,
  mode: quizModeSchema,
});

const quizId = z.uuid();

const answerBody = z.strictObject({
  quizId,
  index: z.number().int().min(0).max(19),
  option: z.number().int().min(0).max(3),
});

sessionRoutes.post("/session", async (c) => {
  const input = startBody.safeParse(await body(c));
  if (!input.success) {
    return c.json(
      {
        error:
          "Pick a category, a difficulty (beginner, intermediate or advanced), a length of 5, 10 or 20 and a mode (practice or exam).",
      },
      400,
    );
  }
  const stub = userSession(c);

  // Cheap check first so an in-progress quiz doesn't cost an assembly query.
  // start() checks again atomically, so a race still can't replace it.
  const inProgress = await stub.getActive();
  if (inProgress) return quizInProgress(c, inProgress);

  const { category, difficulty, length, mode } = input.data;
  const categoryId = await findCategoryId(c.var.db, category);
  if (!categoryId) return c.json({ error: "That category does not exist." }, 404);
  const questions = await assembleQuiz(c.var.db, c.var.user.id, { category, difficulty, length, categoryId });
  if (questions.length === 0) return c.json({ error: "There are no questions at this difficulty yet." }, 404);

  const { started, quiz } = await stub.start({ categoryId, category, difficulty, length, mode, questions });
  if (!started) return quizInProgress(c, quiz);
  return c.json({ quiz }, 201);
});

function quizInProgress(c: Context<AppEnv>, quiz: unknown) {
  return c.json(
    { error: "You already have a quiz in progress. Finish it before starting another.", code: "quiz_in_progress", quiz },
    409,
  );
}

sessionRoutes.get("/session", async (c) => c.json({ quiz: await userSession(c).getActive() }));

sessionRoutes.post("/session/answer", async (c) => {
  const input = answerBody.safeParse(await body(c));
  if (!input.success) {
    return c.json({ error: "Send the quiz id, the question index and the option you picked (0 to 3)." }, 400);
  }

  const { quizId, index, option } = input.data;
  const out = await userSession(c).answer(quizId, index, option);
  if (out.ok) return c.json(out);
  switch (out.code) {
    case "no_quiz":
      return c.json({ error: "There is no quiz in progress.", code: out.code }, 404);
    case "not_current_quiz":
      return c.json({ error: "That quiz is no longer in progress.", code: out.code }, 409);
    case "out_of_order":
      return c.json({ error: "That is not the current question.", code: out.code, currentIndex: out.currentIndex }, 409);
    case "bad_option":
      return c.json({ error: "That option does not exist.", code: out.code }, 400);
  }
});

const finishBody = z.strictObject({ quizId });

sessionRoutes.post("/session/finish", async (c) => {
  const input = finishBody.safeParse(await body(c));
  if (!input.success) return c.json({ error: "Send the id of the quiz to finish." }, 400);

  const out = await userSession(c).finish(input.data.quizId);
  if (!out.ok) return c.json({ error: "There is no such quiz to finish.", code: out.code }, 404);
  return c.json({ alreadyFinished: out.alreadyFinished, result: out.result });
});

sessionRoutes.get("/prefs", async (c) => c.json({ prefs: await userSession(c).getPrefs() }));

sessionRoutes.put("/prefs", async (c) => {
  const input = prefsPatchSchema.safeParse(await body(c));
  if (!input.success) {
    return c.json(
      {
        error:
          "Preferences are defaultDifficulty (beginner, intermediate, advanced), defaultMode (practice, exam), defaultLength (5, 10, 20) and formats.",
      },
      400,
    );
  }
  return c.json({ prefs: await userSession(c).setPrefs(input.data) });
});

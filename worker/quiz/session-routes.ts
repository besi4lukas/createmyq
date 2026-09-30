/**
 * Quiz session and preference routes (STM-9). Thin: validate, then call the
 * signed-in user's UserSession Durable Object. The object is addressed by our
 * users.id from the verified session, never by anything the client sends, so a
 * user can only ever reach their own object.
 *
 *   POST /api/session          start a quiz (409 + the quiz if one is in progress)
 *   GET  /api/session          the quiz in progress, for resume ({ quiz: null } if none)
 *   POST /api/session/answer   { quizId, index, option } → graded in the object
 *   POST /api/session/finish   { quizId } → score + full review, then flush to Postgres (STM-10)
 *   GET  /api/prefs, PUT /api/prefs
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../auth/session";
import { apiError, readJson } from "../http";
import { assertNever } from "../lib/assert";
import { withTimeout } from "../lib/timeout";
import { pickQuestions } from "./assemble";
import { answerBody, finishBody, prefsPatchSchema, startBody } from "./schemas";
import type { PublicQuiz } from "./session-state";

export const sessionRoutes = new Hono<AppEnv>();

const userSession = (c: Context<AppEnv>) =>
  c.env.USER_SESSION.get(c.env.USER_SESSION.idFromName(c.var.user.id));

const quizInProgress = (c: Context<AppEnv>, quiz: PublicQuiz) =>
  apiError(c, 409, "You already have a quiz in progress. Finish it before starting another.", {
    code: "quiz_in_progress",
    quiz,
  });

sessionRoutes.post("/session", async (c) => {
  const input = startBody.safeParse(await readJson(c));
  if (!input.success) {
    return apiError(
      c,
      400,
      "Pick a category, a difficulty (beginner, intermediate or advanced), a length of 5, 10 or 20 and a mode (practice or exam).",
    );
  }
  const stub = userSession(c);

  // Cheap check first so an in-progress quiz doesn't cost an assembly query.
  // start() checks again atomically, so a race still can't replace it.
  const inProgress = await stub.getActive();
  if (inProgress) return quizInProgress(c, inProgress);

  const { category, difficulty, length, mode } = input.data;
  const picked = await pickQuestions(c.var.db, c.var.user.id, { category, difficulty, length });
  if (!picked.ok) return apiError(c, 404, picked.error);

  const { started, quiz } = await stub.start({
    userId: c.var.user.id,
    categoryId: picked.categoryId,
    category,
    difficulty,
    length,
    mode,
    questions: picked.questions,
  });
  if (!started) return quizInProgress(c, quiz);
  return c.json({ quiz }, 201);
});

sessionRoutes.get("/session", async (c) => c.json({ quiz: await userSession(c).getActive() }));

sessionRoutes.post("/session/answer", async (c) => {
  const input = answerBody.safeParse(await readJson(c));
  if (!input.success) {
    return apiError(c, 400, "Send the quiz id, the question index and the option you picked (0 to 3).");
  }

  const { quizId, index, option } = input.data;
  const out = await userSession(c).answer(quizId, index, option);
  if (out.ok) return c.json(out);
  const { code } = out;
  switch (code) {
    case "no_quiz":
      return apiError(c, 404, "There is no quiz in progress.", { code });
    case "not_current_quiz":
      return apiError(c, 409, "That quiz is no longer in progress.", { code });
    case "out_of_order":
      return apiError(c, 409, "That is not the current question.", { code, currentIndex: out.currentIndex });
    case "bad_option":
      return apiError(c, 400, "That option does not exist.", { code });
    default:
      return assertNever(code);
  }
});

/** How long finish waits for the Postgres flush before answering anyway (STM-10). */
const FINISH_WAIT_MS = 5_000;

sessionRoutes.post("/session/finish", async (c) => {
  const input = finishBody.safeParse(await readJson(c));
  if (!input.success) return apiError(c, 400, "Send the id of the quiz to finish.");

  const stub = userSession(c);
  const out = await stub.finish(input.data.quizId);
  if (!out.ok) return apiError(c, 404, "There is no such quiz to finish.", { code: out.code });
  // STM-10: finish() has already stored the result durably in the object and
  // set a retry alarm. Awaiting the flush here means that, normally, the
  // session is in Postgres before we answer (results/history and the 30-day
  // exclusion see it at once). If it fails, the user still gets their result
  // (saved: false) and the alarm keeps retrying. flush() never throws. We wait
  // at most FINISH_WAIT_MS: past that the flush carries on in the object (or
  // the alarm redoes it) and the user shouldn't be kept waiting for it.
  const saved = await withTimeout(stub.flush(input.data.quizId), FINISH_WAIT_MS, () => false);
  return c.json({ alreadyFinished: out.alreadyFinished, saved, result: out.result });
});

sessionRoutes.get("/prefs", async (c) => c.json({ prefs: await userSession(c).getPrefs() }));

sessionRoutes.put("/prefs", async (c) => {
  const input = prefsPatchSchema.safeParse(await readJson(c));
  if (!input.success) {
    return apiError(
      c,
      400,
      "Preferences are defaultDifficulty (beginner, intermediate, advanced), defaultMode (practice, exam), defaultLength (5, 10, 20) and formats.",
    );
  }
  return c.json({ prefs: await userSession(c).setPrefs(input.data) });
});

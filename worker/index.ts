import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { requireSession, type AppEnv } from "./auth/session";
import { apiError } from "./http";
import { quizRoutes } from "./quiz/quiz-routes";
import { sessionRoutes } from "./quiz/session-routes";
import { uploadRoutes } from "./uploads/upload-routes";
import { startGenerationRuns } from "./workflows/queue";

// Durable Object classes must be exported from the Worker entry.
export { UserSession } from "./durable/user-session";
export { GenerationLock } from "./durable/generation-lock";
// Workflow classes too (STM-15).
export { GenerationWorkflow } from "./workflows/generation";

const app = new Hono<AppEnv>().basePath("/api");

// Cross-site form posts are rejected (Origin must match). JSON posts from other
// origins already need a CORS preflight, which this app never grants.
app.use(csrf());
// Every route below needs a signed-in, invited user unless listed as public in session.ts.
app.use(requireSession);

// Public liveness probe: no data, no DB.
app.get("/health", (c) => c.json({ status: "ok" }));

// Real round trip to Neon through Hyperdrive. Signed-in only (STM-5).
app.get("/health/db", async (c) => {
  const result = await c.var.db.execute<{ now: string; version: string }>(
    sql`select now() as now, version() as version`,
  );
  return c.json({ status: "ok", db: result.rows[0] });
});

app.get("/me", (c) => c.json({ user: { id: c.var.user.id, email: c.var.user.email } }));

// STM-8: a fresh quiz from the bank (worker/quiz/quiz-routes.ts).
app.route("/", quizRoutes);

// STM-9: the quiz in progress and preferences, held in the user's Durable Object.
app.route("/", sessionRoutes);

// STM-13: presigned R2 uploads; the file itself never passes through /api.
app.route("/", uploadRoutes);

app.notFound((c) => apiError(c, 404, "Not found"));

app.onError((err, c) => {
  // Deliberate rejections from middleware (e.g. csrf's 403) keep their status.
  if (err instanceof HTTPException && err.status < 500) {
    return apiError(c, err.status, err.status === 403 ? "Request blocked." : "Bad request.");
  }
  console.error(err);
  return apiError(c, 500, "Something went wrong");
});

export default {
  fetch: app.fetch,
  // STM-15: the generation queue's consumer starts one Workflow run per source.
  queue: startGenerationRuns,
} satisfies ExportedHandler<Env>;

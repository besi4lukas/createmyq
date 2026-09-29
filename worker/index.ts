import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { eq, sql } from "drizzle-orm";
import { requireSession, type AppEnv } from "./auth/session";
import { categories } from "./db/schema";
import { assembleQuery, assembleQuiz, toPublicQuestion } from "./quiz/assemble";

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

// STM-8: a fresh quiz from the bank. Read-only; see worker/quiz/assemble.ts.
// e.g. GET /api/quiz?category=system-design&difficulty=beginner&length=10
app.get("/quiz", async (c) => {
  const input = assembleQuery.safeParse(c.req.query());
  if (!input.success) {
    return c.json(
      { error: "Pick a category, a difficulty (beginner, intermediate or advanced) and a length of 5, 10 or 20." },
      400,
    );
  }
  const { category, difficulty, length } = input.data;

  const [cat] = await c.var.db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, category));
  if (!cat) return c.json({ error: "That category does not exist." }, 404);

  const picked = await assembleQuiz(c.var.db, c.var.user.id, { ...input.data, categoryId: cat.id });
  if (picked.length === 0) {
    return c.json({ error: "There are no questions at this difficulty yet." }, 404);
  }
  return c.json({
    category,
    difficulty,
    length,
    // true when the whole pool is smaller than the requested length (see assemble.ts)
    short: picked.length < length,
    questions: picked.map(toPublicQuestion),
  });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  // Deliberate rejections from middleware (e.g. csrf's 403) keep their status.
  if (err instanceof HTTPException && err.status < 500) {
    return c.json({ error: err.status === 403 ? "Request blocked." : "Bad request." }, err.status);
  }
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

export default app;

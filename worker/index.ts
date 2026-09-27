import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import auth from "./auth/routes";
import { requireSession, type AppEnv } from "./auth/session";

const app = new Hono<AppEnv>().basePath("/api");

// Cross-site form posts are rejected (Origin must match). JSON posts from other
// origins already need a CORS preflight, which this app never grants.
app.use(csrf());
// Every route below needs a signed-in user unless listed as public in session.ts.
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

app.route("/auth", auth);

app.get("/me", (c) => c.json({ user: c.var.user }));

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

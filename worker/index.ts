import { Hono } from "hono";
import { withDb } from "./db/client";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.get("/health", (c) => c.json({ status: "ok" }));

// Real round trip to Neon through Hyperdrive. Errors fall through to onError.
app.get("/health/db", async (c) => {
  const row = await withDb(c.env, c.executionCtx, async (db) => {
    const result = await db.query<{ now: Date; version: string }>(
      "select now() as now, version() as version",
    );
    return result.rows[0];
  });
  return c.json({ status: "ok", db: row });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

export default app;

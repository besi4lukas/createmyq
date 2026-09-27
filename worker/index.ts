import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.get("/health", (c) => c.json({ status: "ok" }));

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

export default app;

/**
 * POST /api/sources/link and GET /api/sources/:id against real SQL (PGlite,
 * the repo's migrations) behind the Hyperdrive-like read cache, with the
 * UserSession and the queue stubbed. Same contract as /uploads/complete.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../auth/session";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { BAD_URL, BLOCKED_URL } from "../extract/source-url";
import { withQueryCache } from "../testing/query-cache";
import { NOT_A_LINK } from "./link-rules";
import { sourceRoutes } from "./source-routes";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const ARTICLE = "https://martinfowler.com/articles/microservices.html#intro";
const VIDEO = "https://youtu.be/8aGhZQkoFbQ?t=30";

let pg: PGlite;
let db: Db;
let cache: Map<string, unknown>;
let counted: Set<string>;
let capLimit: number;
let ceilingUsd: string;
const send = vi.fn(async () => {});

const window = () => ({ day: "2026-10-08", timeZone: "UTC", resetAt: Date.UTC(2026, 9, 9), sourceIds: [...counted] });
const userSession = {
  reserveGeneration: (sourceId: string) => {
    if (counted.has(sourceId)) return { ok: true, counted: false, limit: capLimit, window: window() };
    if (counted.size >= capLimit) return { ok: false, counted: false, limit: capLimit, window: window() };
    counted.add(sourceId);
    return { ok: true, counted: true, limit: capLimit, window: window() };
  },
};

const app = (userId: string) =>
  new Hono<AppEnv>()
    .basePath("/api")
    .use(async (c, next) => {
      c.set("user", { id: userId, email: "a@x.test" });
      c.set("db", db);
      await next();
    })
    .route("/", sourceRoutes);

const env = () =>
  ({
    USER_SESSION: { idFromName: (n: string) => n, get: () => userSession },
    GENERATION_QUEUE: { send },
    SPEND_CEILING_USD: ceilingUsd,
  }) as unknown as Env;

async function postLink(body: unknown, userId = U1) {
  const res = await app(userId).request(
    "/api/sources/link",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function getSource(id: string, userId = U1) {
  const res = await app(userId).request(`/api/sources/${id}`, {}, env());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const rows = async () =>
  (await db.execute<{ id: string; kind: string; url: string; title: string; status: string; visibility: string }>(
    sql`select id, kind, url, title, status, visibility from sources order by created_at`,
  )).rows;

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await migrate(drizzle({ client: pg, schema }), { migrationsFolder: "drizzle" /* vitest runs from the repo root */ });
  const cached = withQueryCache(pg);
  cache = cached.cache;
  db = drizzle({ client: cached.client, schema }) as unknown as Db;
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`truncate invites, users, sources, model_calls, questions cascade;
    insert into invites (email) values ('a@x.test'), ('b@x.test');
    insert into users (id, email) values ('${U1}', 'a@x.test'), ('${U2}', 'b@x.test');`);
  cache.clear();
  counted = new Set();
  capLimit = 3;
  ceilingUsd = "15";
  send.mockClear();
});

describe("POST /api/sources/link", () => {
  it("an article: a private uploaded source with the normalised url, counted and queued", async () => {
    const requestId = crypto.randomUUID();
    const res = await postLink({ url: ARTICLE, requestId, timeZone: "America/Chicago" });
    expect(res.status).toBe(201);
    expect(res.body.source).toMatchObject({ id: requestId, status: "uploaded", bankSourceId: requestId });
    expect(await rows()).toEqual([
      {
        id: requestId,
        kind: "article",
        url: "https://martinfowler.com/articles/microservices.html",
        title: "martinfowler.com/articles/microservices.html",
        status: "uploaded",
        visibility: "private",
      },
    ]);
    expect(send).toHaveBeenCalledExactlyOnceWith({ sourceId: requestId });
    expect([...counted]).toEqual([requestId]);
  });

  it("a YouTube link: kind youtube, canonical watch url", async () => {
    const requestId = crypto.randomUUID();
    expect((await postLink({ url: VIDEO, requestId })).status).toBe(201);
    expect(await rows()).toMatchObject([
      { kind: "youtube", url: "https://www.youtube.com/watch?v=8aGhZQkoFbQ", title: "YouTube video 8aGhZQkoFbQ" },
    ]);
  });

  it("the same requestId again: same source, 200, counted and stored once (even with the cap now full)", async () => {
    const requestId = crypto.randomUUID();
    await postLink({ url: ARTICLE, requestId });
    capLimit = 1;
    ceilingUsd = "0";
    const again = await postLink({ url: ARTICLE, requestId });
    expect(again.status).toBe(200);
    expect(again.body.source).toMatchObject({ id: requestId });
    expect(await rows()).toHaveLength(1);
    expect(counted.size).toBe(1);
  });

  it.each([
    ["empty", "   ", NOT_A_LINK],
    ["not a url", "martin fowler microservices", BAD_URL],
    ["ftp", "ftp://example.com/file", BAD_URL],
    ["javascript:", "javascript:alert(1)", BAD_URL],
    ["localhost", "http://localhost:8787/api/health", BLOCKED_URL],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/", BLOCKED_URL],
    ["private network", "https://10.0.0.5/admin", BLOCKED_URL],
    ["credentials", "https://user:pass@example.com/", BLOCKED_URL],
    ["odd port", "https://example.com:8443/", BLOCKED_URL],
    ["YouTube channel, not a video", "https://www.youtube.com/@jsconf", "That YouTube link doesn't point at a video. Paste the link to one video."],
  ])("refuses %s with a friendly 400, and records nothing", async (_, url, message) => {
    const res = await postLink({ url, requestId: crypto.randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
    expect(await rows()).toEqual([]);
    expect(counted.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a malformed body (no requestId) is a 400 with the friendly message", async () => {
    const res = await postLink({ url: ARTICLE });
    expect(res).toMatchObject({ status: 400, body: { error: NOT_A_LINK } });
  });

  it("over the daily cap: 429 daily_cap with the reset time, nothing stored or queued", async () => {
    capLimit = 0;
    const res = await postLink({ url: ARTICLE, requestId: crypto.randomUUID() });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "daily_cap", limit: 0, resetAt: "2026-10-09T00:00:00.000Z" });
    expect(String(res.body.error)).toMatch(/^You have hit today's limit\. It resets at midnight\./);
    expect(await rows()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("over the spend ceiling: 503 spend_ceiling, nothing stored, counted or queued", async () => {
    ceilingUsd = "0";
    const res = await postLink({ url: ARTICLE, requestId: crypto.randomUUID() });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("spend_ceiling");
    expect(await rows()).toEqual([]);
    expect(counted.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a requestId that is another user's source: 409, and they don't get linked to it", async () => {
    const requestId = crypto.randomUUID();
    await postLink({ url: ARTICLE, requestId }, U2);
    const res = await postLink({ url: VIDEO, requestId }, U1);
    expect(res.status).toBe(409);
    const links = await db.execute(sql`select user_id from source_uploads`);
    expect(links.rows).toEqual([{ user_id: U2 }]);
  });
});

describe("GET /api/sources/:id", () => {
  it("shows the stored off-topic message of a refused source, and only to its uploader", async () => {
    const requestId = crypto.randomUUID();
    await postLink({ url: ARTICLE, requestId });
    const refusal = "This looks like cooking. CreateMyQ only covers software engineering right now.";
    await db.execute(sql`update sources set status = 'refused', error = ${refusal} where id = ${requestId}`);
    cache.clear(); // a status poll may lag a minute behind; that's all a cache can do here
    const mine = await getSource(requestId);
    expect(mine.status).toBe(200);
    expect(mine.body.source).toMatchObject({ id: requestId, kind: "article", status: "refused", error: refusal, questionCount: 0 });
    expect((await getSource(requestId, U2)).status).toBe(404);
    expect((await getSource("not-a-uuid")).status).toBe(404);
  });

  it("a duplicate shows its bank's status, error and question count", async () => {
    const bankId = crypto.randomUUID();
    const dupId = crypto.randomUUID();
    await postLink({ url: ARTICLE, requestId: bankId }, U2);
    await postLink({ url: ARTICLE, requestId: dupId }, U1);
    await db.execute(sql`update sources set status = 'ready' where id = ${bankId}`);
    await db.execute(sql`update sources set status = 'duplicate', duplicate_of_id = ${bankId} where id = ${dupId}`);
    await db.execute(sql`insert into questions (source_id, origin, format, difficulty, topic, prompt, explanation, payload)
      select ${bankId}, 'generated', 'multiple_choice', 'beginner', 't', 'p' || g, 'e', '{"options":["a","b","c","d"],"answer":"a"}'::jsonb
      from generate_series(1, 3) g`);
    await db.execute(sql`update questions set status = 'retired' where prompt = 'p3'`);
    cache.clear();
    const res = await getSource(dupId);
    expect(res.body.source).toMatchObject({ id: dupId, status: "ready", bankSourceId: bankId, questionCount: 2, error: null });
  });
});

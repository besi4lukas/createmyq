/**
 * POST /api/uploads/complete against real SQL (PGlite, the repo's migrations)
 * behind a stand-in for Hyperdrive's query cache.
 *
 * Production reaches Neon through Hyperdrive, whose query caching is on by
 * default: an identical read-only SELECT (same text, same parameters) can be
 * answered from cache for up to 60 s, and a write does NOT invalidate it
 * (developers.cloudflare.com/hyperdrive/concepts/query-caching). Local dev has
 * no such cache, so a read-after-write bug only shows up in production. The
 * cache below answers every repeated SELECT from its first result, inside
 * transactions too: the worst case. Correctness must not depend on a read.
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
import { uploadRoutes } from "./upload-routes";
import { uploadKey } from "./upload-rules";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

type Queryable = { query: (...args: unknown[]) => Promise<unknown>; transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };

/** Every repeated SELECT is served from its first answer; writes never invalidate. */
function withQueryCache(client: PGlite) {
  const cache = new Map<string, unknown>();
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const q = t as unknown as Queryable;
        if (prop === "query") {
          return async (text: string, params?: unknown[], opts?: unknown) => {
            if (!/^\s*select\b/i.test(text)) return q.query(text, params, opts);
            const key = `${text}\u0000${JSON.stringify(params ?? [])}`;
            if (!cache.has(key)) cache.set(key, await q.query(text, params, opts));
            return cache.get(key);
          };
        }
        if (prop === "transaction") return (fn: (tx: unknown) => Promise<unknown>) => q.transaction((tx) => fn(wrap(tx as object)));
        const value = Reflect.get(t, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
      },
    });
  return { client: wrap(client), cache };
}

let pg: PGlite;
let db: Db;
let cache: Map<string, unknown>;
let objects: Map<string, { size: number; httpMetadata: { contentType: string } }>;
let counted: Set<string>;
let capLimit: number;
let ceilingUsd: string;
const send = vi.fn(async () => {});

const window = () => ({ day: "2026-10-08", timeZone: "UTC", resetAt: Date.UTC(2026, 9, 9), sourceIds: [...counted] });
const userSession = {
  generationAllowance: () => ({ limit: capLimit, used: counted.size, remaining: capLimit - counted.size, window: window() }),
  reserveGeneration: (sourceId: string) => {
    if (counted.has(sourceId)) return { ok: true, counted: false, limit: capLimit, window: window() };
    if (counted.size >= capLimit) return { ok: false, counted: false, limit: capLimit, window: window() };
    counted.add(sourceId);
    return { ok: true, counted: true, limit: capLimit, window: window() };
  },
};

function app(userId: string) {
  return new Hono<AppEnv>()
    .basePath("/api")
    .use(async (c, next) => {
      c.set("user", { id: userId, email: "a@x.test" });
      c.set("db", db);
      await next();
    })
    .route("/", uploadRoutes);
}

function env(): Env {
  return {
    UPLOADS: {
      head: async (key: string) => objects.get(key) ?? null,
      delete: async (key: string) => void objects.delete(key),
    },
    USER_SESSION: { idFromName: (n: string) => n, get: () => userSession },
    GENERATION_QUEUE: { send },
    SPEND_CEILING_USD: ceilingUsd,
  } as unknown as Env;
}

async function complete(sourceId: string, userId = U1) {
  const res = await app(userId).request(
    "/api/uploads/complete",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId, filename: "MapReduce.pdf" }) },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function putObject(userId: string, sourceId: string) {
  objects.set(uploadKey(userId, sourceId), { size: 1234, httpMetadata: { contentType: "application/pdf" } });
}

const sourceRows = async () =>
  (await db.execute<{ id: string; status: string }>(sql`select id, status from sources order by created_at`)).rows;

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await migrate(drizzle({ client: pg, schema }), { migrationsFolder: "drizzle" /* vitest runs from the repo root */ });
  const cached = withQueryCache(pg);
  cache = cached.cache;
  db = drizzle({ client: cached.client, schema }) as unknown as Db;
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`truncate invites, users, sources, model_calls cascade;
    insert into invites (email) values ('a@x.test'), ('b@x.test');
    insert into users (id, email) values ('${U1}', 'a@x.test'), ('${U2}', 'b@x.test');`);
  cache.clear();
  objects = new Map();
  counted = new Set();
  capLimit = 3;
  ceilingUsd = "15";
  send.mockClear();
});

describe("POST /api/uploads/complete behind a read cache (Hyperdrive)", () => {
  it("creates the source and queues it, though the same read was cached before the insert", async () => {
    const id = crypto.randomUUID();
    putObject(U1, id);
    const res = await complete(id);
    expect(res.status).toBe(200);
    expect(res.body.source).toMatchObject({ id, title: "MapReduce", status: "uploaded", bankSourceId: id });
    expect(await sourceRows()).toEqual([{ id, status: "uploaded" }]);
    expect(send).toHaveBeenCalledExactlyOnceWith({ sourceId: id });
    expect([...counted]).toEqual([id]);
  });

  it("a retried complete returns the same source, counts it once and keeps the object", async () => {
    const id = crypto.randomUUID();
    putObject(U1, id);
    expect((await complete(id)).status).toBe(200);
    capLimit = 1; // full now: a retry must not be refused (it is not a new run)
    ceilingUsd = "0";
    const again = await complete(id);
    expect(again.status).toBe(200);
    expect(again.body.source).toMatchObject({ id, status: "uploaded" });
    expect(await sourceRows()).toHaveLength(1);
    expect(counted.size).toBe(1);
    expect(objects.has(uploadKey(U1, id))).toBe(true);
  });

  it("over the daily cap: 429, no row, object deleted, nothing queued", async () => {
    capLimit = 0;
    const id = crypto.randomUUID();
    putObject(U1, id);
    const res = await complete(id);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("daily_cap");
    expect(await sourceRows()).toEqual([]);
    expect(objects.has(uploadKey(U1, id))).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("over the spend ceiling: 503, no row, nothing counted", async () => {
    ceilingUsd = "0";
    const id = crypto.randomUUID();
    putObject(U1, id);
    const res = await complete(id);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("spend_ceiling");
    expect(await sourceRows()).toEqual([]);
    expect(counted.size).toBe(0);
  });

  it("no object under the caller's prefix: 404 upload_not_found", async () => {
    const id = crypto.randomUUID();
    putObject(U2, id);
    const res = await complete(id, U1);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("upload_not_found");
    expect(await sourceRows()).toEqual([]);
  });

  it("GET /api/uploads/:id finds the caller's own source and 404s for another user", async () => {
    const id = crypto.randomUUID();
    putObject(U1, id);
    await complete(id);
    cache.clear(); // GET reads; a cache only delays what it shows, tested above for complete
    const mine = await app(U1).request(`/api/uploads/${id}`, {}, env());
    expect(mine.status).toBe(200);
    const theirs = await app(U2).request(`/api/uploads/${id}`, {}, env());
    expect(theirs.status).toBe(404);
  });
});

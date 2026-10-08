/**
 * Test-only stand-in for Hyperdrive's query cache: every repeated read-only
 * SELECT (same text, same parameters) is answered from its first result, and
 * writes never invalidate it. Inside transactions too: the worst case.
 * Wraps a PGlite client for drizzle-orm/pglite.
 */
import type { PGlite } from "@electric-sql/pglite";

type Queryable = { query: (...args: unknown[]) => Promise<unknown>; transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };

export function withQueryCache(client: PGlite) {
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


import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt, sql } from "drizzle-orm";
import { withDb, type Db } from "../db/client";
import { authSessions, users } from "../db/schema";
import { hashToken } from "./tokens";

export type SessionUser = { id: string; email: string };
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser; db: Db } };

/** Sent as `__Host-stumper_session`: the prefix forces Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = "stumper_session";
export const SESSION_DAYS = 30;

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { prefix: "host", secure: true, path: "/" });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE, "host");
}

/**
 * Routes reachable without a session. Everything else under /api needs one, so a
 * new route is protected by default. /api/health stays public as a liveness
 * probe (no data, no DB); /api/health/db is protected.
 */
const PUBLIC = new Set([
  "GET /api/health",
  "POST /api/auth/request",
  "POST /api/auth/verify",
  "POST /api/auth/logout",
]);

const unauthorized = (c: Context) => c.json({ error: "Please sign in." }, 401);

/**
 * Requires a valid, unexpired session for every non-public route. Opens the
 * request's DB connection once and exposes it as `c.var.db` alongside
 * `c.var.user`, so routes don't open a second connection.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (PUBLIC.has(`${c.req.method} ${c.req.path}`)) return next();

  const token = readSessionCookie(c);
  if (!token) return unauthorized(c);
  const tokenHash = await hashToken(token);

  return withDb(c.env, c.executionCtx, async (db) => {
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(eq(authSessions.tokenHash, tokenHash), gt(authSessions.expiresAt, sql`now()`)));
    if (!user) return unauthorized(c);
    c.set("user", user);
    c.set("db", db);
    await next();
  });
};

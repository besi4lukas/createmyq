import type { Context, MiddlewareHandler } from "hono";
import { verifyToken } from "@clerk/backend";
import { eq, sql } from "drizzle-orm";
import { withDb, type Db } from "../db/client";
import { invites, users } from "../db/schema";

export type SessionUser = { id: string; email: string };
export type AppEnv = { Bindings: Env; Variables: { user: SessionUser; db: Db } };

/**
 * Routes reachable without a session. Everything else under /api needs one, so a
 * new route is protected by default. /api/health stays public as a liveness
 * probe (no data, no DB); /api/health/db is protected.
 */
const PUBLIC = new Set(["GET /api/health"]);

const unauthorized = (c: Context) => c.json({ error: "Please sign in." }, 401);

/**
 * Sign-in is Clerk (email code). The SPA sends the Clerk session token as
 * `Authorization: Bearer …`; the `__session` cookie is ignored, so there is no
 * CSRF exposure and no handshake redirect. The token is verified networkless
 * with CLERK_JWT_KEY (the instance's JWKS public key, a secret) and must have
 * been minted for this origin (`azp`).
 *
 * Clerk only says who someone is. Whether they may use CreateMyQ is our
 * `invites` table: an invited email gets a `users` row on its first request,
 * anyone else gets 403 `not_invited`.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (PUBLIC.has(`${c.req.method} ${c.req.path}`)) return next();

  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return unauthorized(c);

  // Not in the generated Env until .dev.vars has it, so read it loosely. Fail closed.
  const jwtKey = (c.env as { CLERK_JWT_KEY?: string }).CLERK_JWT_KEY;
  if (!jwtKey) {
    console.error("CLERK_JWT_KEY is not set; refusing every signed-in route");
    return c.json({ error: "Something went wrong" }, 500);
  }

  let claims: Record<string, unknown>;
  try {
    claims = await verifyToken(token, {
      jwtKey,
      authorizedParties: [new URL(c.req.url).origin],
      clockSkewInMs: 10_000,
    });
  } catch {
    return unauthorized(c);
  }

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) {
    console.error(
      'Clerk session token has no email claim; add {"email": "{{user.primary_email_address}}"} under Sessions → Customize session token',
    );
    return unauthorized(c);
  }

  return withDb(c.env, c.executionCtx, async (db) => {
    const user = await findOrCreateUser(db, email);
    if (!user) {
      return c.json({ error: "This email is not on the invite list.", code: "not_invited" }, 403);
    }
    c.set("user", user);
    c.set("db", db);
    await next();
  });
};

/**
 * The user for an invited email, created on its first request. Returns null
 * when the email isn't invited. `users.email` references `invites.email`, so an
 * existing user row means the invite still stands.
 */
async function findOrCreateUser(db: Db, email: string): Promise<SessionUser | null> {
  const byEmail = () =>
    db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email));

  const [existing] = await byEmail();
  if (existing) return existing;

  return db.transaction(async (tx) => {
    const [invite] = await tx
      .update(invites)
      .set({ usedAt: sql`coalesce(${invites.usedAt}, now())` })
      .where(eq(invites.email, email))
      .returning({ email: invites.email });
    if (!invite) return null;
    // Two first requests can race; the unique email makes the second a no-op.
    await tx.insert(users).values({ email }).onConflictDoNothing();
    const [user] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email));
    return user ?? null;
  });
}

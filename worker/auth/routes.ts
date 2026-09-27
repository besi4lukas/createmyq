import { Hono } from "hono";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { withDb } from "../db/client";
import { authSessions, invites, magicLinks, users } from "../db/schema";
import { getMailer, type MailEnv } from "./mailer";
import {
  SESSION_DAYS,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  type AppEnv,
} from "./session";
import { hashToken, randomToken } from "./tokens";

const LINK_MINUTES = 15;
/** Trivial guard against mail-bombing an invited address. */
const MAX_LINKS_PER_WINDOW = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const auth = new Hono<AppEnv>();

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * POST /api/auth/request {email}
 * Always answers the same way whether or not the email is invited. All the work
 * (lookup, insert, send) runs after the response via waitUntil, so neither the
 * body nor the timing reveals who is on the allowlist.
 */
auth.post("/request", async (c) => {
  const body = await readJson(c.req.raw);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return c.json({ error: "Please enter a valid email address." }, 400);
  }

  const origin = new URL(c.req.url).origin;
  const env = c.env as MailEnv;
  const ctx = c.executionCtx;

  const work = withDb(env, ctx, async (db) => {
    const [invite] = await db.select().from(invites).where(eq(invites.email, email));
    if (!invite) return;

    const [recent] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(magicLinks)
      .where(
        and(
          eq(magicLinks.email, email),
          gt(magicLinks.createdAt, sql`now() - make_interval(mins => ${LINK_MINUTES})`),
        ),
      );
    if ((recent?.n ?? 0) >= MAX_LINKS_PER_WINDOW) {
      console.warn("magic link rate limit hit");
      return;
    }

    const token = randomToken();
    await db.insert(magicLinks).values({
      tokenHash: await hashToken(token),
      email,
      expiresAt: sql`now() + make_interval(mins => ${LINK_MINUTES})`,
    });
    // Token in the fragment: never sent to the server, so it stays out of
    // request logs and Referer headers. The SPA page POSTs it on a click.
    await getMailer(env, c.req.url).sendMagicLink(email, `${origin}/auth/verify#token=${token}`);
  }).catch((err) => console.error("magic link request failed", err));

  ctx.waitUntil(work);
  return c.json({ ok: true, message: "If that email is invited, a sign-in link is on its way." });
});

/**
 * POST /api/auth/verify {token}
 * Consumes the token atomically (the UPDATE only matches an unused, unexpired
 * row), re-checks the invite, finds or creates the user, and starts a session.
 * All in one transaction: if anything fails the token is not burned.
 */
auth.post("/verify", async (c) => {
  const body = await readJson(c.req.raw);
  const token = typeof body.token === "string" ? body.token : "";
  const invalid = () =>
    c.json({ error: "This sign-in link is invalid or has expired. Request a new one." }, 400);
  if (!token || token.length > 128) return invalid();
  const tokenHash = await hashToken(token);
  const sessionToken = randomToken();
  const sessionHash = await hashToken(sessionToken);

  const user = await withDb(c.env, c.executionCtx, (db) =>
    db.transaction(async (tx) => {
      const [link] = await tx
        .update(magicLinks)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(magicLinks.tokenHash, tokenHash),
            isNull(magicLinks.usedAt),
            gt(magicLinks.expiresAt, sql`now()`),
          ),
        )
        .returning({ email: magicLinks.email });
      if (!link) return null;

      // Re-check the allowlist: the invite may have been revoked after the link was sent.
      const [invite] = await tx
        .update(invites)
        .set({ usedAt: sql`coalesce(${invites.usedAt}, now())` })
        .where(eq(invites.email, link.email))
        .returning({ email: invites.email });
      if (!invite) return null;

      await tx.insert(users).values({ email: invite.email }).onConflictDoNothing();
      const [row] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, invite.email));
      if (!row) throw new Error("user row missing after upsert");

      await tx.insert(authSessions).values({
        tokenHash: sessionHash,
        userId: row.id,
        expiresAt: sql`now() + make_interval(days => ${SESSION_DAYS})`,
      });
      return row;
    }),
  );

  if (!user) return invalid();
  setSessionCookie(c, sessionToken);
  return c.json({ user });
});

/** POST /api/auth/logout: deletes the session row (if any) and clears the cookie. */
auth.post("/logout", async (c) => {
  const token = readSessionCookie(c);
  if (token) {
    const tokenHash = await hashToken(token);
    await withDb(c.env, c.executionCtx, (db) =>
      db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash)),
    );
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

export default auth;

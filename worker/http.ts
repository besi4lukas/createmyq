/**
 * HTTP plumbing shared by every route: the one error body shape and reading a
 * JSON body. Nothing domain-specific lives here.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Every error response is `{ error, ...extra }`: `error` is a sentence safe to
 * show the user, `extra` carries a machine-readable `code` and any data the
 * client needs (e.g. the quiz in progress on a 409).
 */
export function apiError(c: Context, status: ContentfulStatusCode, error: string, extra?: Record<string, unknown>) {
  return c.json({ error, ...extra }, status);
}

/** The JSON body, or undefined if it isn't JSON (the route's schema then rejects it as 400). */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

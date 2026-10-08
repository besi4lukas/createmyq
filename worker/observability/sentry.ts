/**
 * STM-27: Sentry for the Worker (fetch, queue and the generation Workflow).
 *
 * Off unless the secret SENTRY_DSN is set: with no DSN the SDK is disabled and
 * sends nothing, and the app behaves exactly as before. Errors only (no
 * tracing, no breadcrumbs), and every event goes through `scrubEvent` first:
 * the app's data is friends' emails, their uploads and their answers, and none
 * of it may leave for Sentry. What remains is the error type, message (with
 * emails, tokens and query strings masked), stack, route path and runtime.
 *
 * Durable Objects are deliberately not wrapped: Sentry's DO wrapper writes its
 * own keys into DO storage on every alarm, and UserSession's storage is the
 * flush path (CLAUDE.md "the one place data can be lost"). A DO error thrown
 * into a route still reaches Sentry through app.onError; the flush alarm's
 * failures are in Workers Logs (`session_flush_*`).
 */
import type { CloudflareOptions } from "@sentry/cloudflare";

/** The optional bindings Sentry reads. Not in wrangler.jsonc: SENTRY_DSN is a secret. */
export type SentryEnv = { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string };

type SentryEvent = Parameters<NonNullable<CloudflareOptions["beforeSend"]>>[0];

/** Masks the things that may be personal or secret inside free text (error messages). */
export function scrubText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\bBearer\s+[^\s"',]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]")
    .replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?[redacted]")
    .replace(/\b(postgres(?:ql)?:\/\/)[^\s"'<>]+/gi, "$1[redacted]");
}

/** A URL without its query string and fragment (they can carry user data). */
function bareUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Drops everything that can carry personal data and masks free text. Pure, so
 * the Worker and its tests share it. Returns the same event object.
 */
export function scrubEvent<E extends SentryEvent>(event: E): E {
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.server_name;
  if (event.request) {
    event.request = {
      method: event.request.method,
      url: event.request.url ? bareUrl(event.request.url) : undefined,
    };
  }
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry = { message: scrubText(event.logentry.message) };
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
  }
  return event;
}

/** Sentry options from the Worker's env. `enabled` is false without a DSN, so nothing is sent. */
export function sentryOptions(workerEnv: object): CloudflareOptions {
  const env = workerEnv as SentryEnv;
  const dsn = env.SENTRY_DSN?.trim() || undefined;
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: env.SENTRY_ENVIRONMENT || "production",
    // Every error (a few friends: well inside the free plan's quota). No tracesSampleRate:
    // leaving it unset turns tracing off altogether (0 would still run the span machinery).
    sampleRate: 1,
    // SDK v11 collects headers, cookies, query strings, bodies, DB/queue/AI payloads and
    // user info by default. Turn every one off; scrubEvent is the second line.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubEvent(event),
  };
}

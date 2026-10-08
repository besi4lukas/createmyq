/**
 * STM-27: what the SPA may send to Sentry. Pure, so it is unit-tested. The
 * Worker has its own copy (worker/observability/sentry.ts; src/ never imports
 * from worker/): the same rules, no emails, tokens, query strings, user,
 * breadcrumbs or extra data. Question and source text never reach an error
 * message in this app; the breadcrumbs that could carry it are dropped.
 */
type Scrubbable = {
  message?: string;
  user?: unknown;
  breadcrumbs?: unknown;
  extra?: unknown;
  request?: { url?: string; method?: string; [key: string]: unknown };
  logentry?: { message?: string; [key: string]: unknown };
  exception?: { values?: { value?: string }[] };
};

/** Masks emails, bearer tokens, JWTs and URL query strings / fragments in free text. */
export function scrubText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\bBearer\s+[^\s"',]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]")
    .replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?[redacted]");
}

/** Drops what can carry personal data and masks free text. Returns the same object. */
export function scrubEvent<E extends object>(e: E): E {
  const event = e as Scrubbable;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  if (event.request) {
    const url = event.request.url;
    const cut = url ? url.search(/[?#]/) : -1;
    event.request = { url: url && cut !== -1 ? url.slice(0, cut) : url };
  }
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry = { message: scrubText(event.logentry.message) };
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
  }
  return e;
}

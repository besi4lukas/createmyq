/**
 * Link intake rules (article / YouTube), as pure functions. The route parses
 * with `linkSourceBody`, asks `checkLink`, and records the source.
 *
 * The link is checked twice: here at intake (parseSourceUrl: http(s) only, no
 * credentials, default ports, no localhost / private / link-local addresses,
 * YouTube links must name one video), and again on every redirect hop when
 * the Workflow fetches it (worker/extract/safe-fetch.ts).
 *
 * `requestId` is made by the browser once per "Make my quiz" press and becomes
 * the source id, so a retried request (a timeout, a double press) finds the
 * same source and is not counted against the daily cap twice.
 */
import { z } from "zod";
import { parseSourceUrl, type SourceUrl } from "../extract/source-url";

export const MAX_URL_LENGTH = 2048;
export const NOT_A_LINK = "Paste a link to an article or a YouTube video.";

export const linkSourceBody = z.strictObject({
  url: z.string().max(MAX_URL_LENGTH),
  requestId: z.uuid(),
  timeZone: z.string().max(64).optional(),
});
export type LinkSourceBody = z.infer<typeof linkSourceBody>;

export type LinkCheck = { ok: true; link: SourceUrl } | { ok: false; error: string; code: string };

export function checkLink(input: string): LinkCheck {
  if (!input.trim()) return { ok: false, error: NOT_A_LINK, code: "bad_url" };
  const parsed = parseSourceUrl(input);
  if ("ok" in parsed) return { ok: false, error: parsed.message, code: parsed.code };
  return { ok: true, link: parsed };
}

/**
 * The name shown until something better exists: host + path for an article
 * ("martinfowler.com/articles/microservices.html"), "YouTube video <id>".
 */
export function titleFromLink(link: SourceUrl): string {
  if (link.kind === "youtube") return `YouTube video ${link.videoId}`;
  const url = new URL(link.url);
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${host}${path}`.slice(0, 200);
}

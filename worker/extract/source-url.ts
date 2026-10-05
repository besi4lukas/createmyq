/**
 * STM-14: what a pasted link is. Pure: no fetching here.
 *
 *   parseSourceUrl("https://youtu.be/8aGhZQkoFbQ")  → { kind: "youtube", videoId, url }
 *   parseSourceUrl("https://martinfowler.com/…")    → { kind: "article", url }
 *
 * Article URLs must be http(s), on the default port, without credentials, and
 * not aimed at this machine or a private network (checkFetchTarget). The same
 * check runs again on every redirect hop (safe-fetch.ts). A hostname that
 * resolves to a private address can't be caught here (Workers has no DNS
 * lookup); in production the Worker can't reach private networks anyway.
 */
import { fail, type ExtractFailure } from "./result";

export type SourceUrl = { kind: "article"; url: string } | { kind: "youtube"; videoId: string; url: string };

export const BAD_URL = "That doesn't look like a web link. Paste a link that starts with https://.";
export const BLOCKED_URL = "I can't open that link. Try a public web page.";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function parseSourceUrl(input: string): SourceUrl | ExtractFailure {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return fail("bad_url", BAD_URL);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("bad_url", BAD_URL);

  const videoId = youtubeVideoId(url);
  if (videoId) return { kind: "youtube", videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
  if (isYouTubeHost(url.hostname)) {
    return fail("bad_url", "That YouTube link doesn't point at a video. Paste the link to one video.");
  }

  const blocked = checkFetchTarget(url);
  if (blocked) return blocked;
  url.hash = "";
  return { kind: "article", url: url.toString() };
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return YOUTUBE_HOSTS.has(host) || host === "youtu.be";
}

/** watch?v=, youtu.be/<id>, /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>. Null when it isn't one. */
export function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const [, first, second] = url.pathname.split("/");
    if (first === "watch") id = url.searchParams.get("v");
    else if (first && ["shorts", "embed", "live", "v"].includes(first)) id = second ?? null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** Null when `url` is fine to fetch; otherwise the failure. Runs on every redirect hop too. */
export function checkFetchTarget(url: URL): ExtractFailure | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("bad_url", BAD_URL);
  if (url.username || url.password) return fail("blocked_url", BLOCKED_URL, { detail: "credentials in url" });
  if (url.port && url.port !== "80" && url.port !== "443") {
    return fail("blocked_url", BLOCKED_URL, { detail: `port ${url.port}` });
  }
  if (isPrivateHost(url.hostname)) return fail("blocked_url", BLOCKED_URL, { detail: `host ${url.hostname}` });
  return null;
}

/** localhost and friends, single-label names, and IP literals in loopback/private/link-local/reserved ranges. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) return isPrivateIPv6(host.slice(1, -1));
  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4(v4);
  if (!host.includes(".")) return true; // "localhost", "intranet", …
  return /\.(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host);
}

/** WHATWG URL parsing already turns 0x7f.1, 2130706433 etc. into dotted decimal. */
function parseIPv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isPrivateIPv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d, which URL normalises to ::ffff:xxxx:xxxx).
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1] ?? "0", 16);
    return isPrivateIPv4([hi >> 8, hi & 0xff]);
  }
  if (h.startsWith("::ffff:")) return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(h); // unique-local, link-local, multicast
}

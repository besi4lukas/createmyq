/**
 * STM-14: a YouTube video → its captions as text. No API key, no OAuth.
 *
 * The official Data API only serves captions to the video's owner, so this
 * does what the open-source transcript tools do (youtube-transcript-api):
 *
 *   1. POST youtube.com/youtubei/v1/player as the Android app (InnerTube, the
 *      API YouTube's own clients use). Its caption track URLs work without the
 *      "proof of origin" token the web player's URLs now need.
 *   2. Pick a track: English, uploaded captions before auto-generated ones.
 *   3. GET the track (srv3 XML), drop [Music]-style annotations, and group the
 *      cues into paragraphs, each with a "m:ss" span.
 *
 * FRAGILE BY NATURE: this is an undocumented API. YouTube changes client
 * versions, may start asking for tokens, and blocks some datacenter IPs ("Sign
 * in to confirm you're not a bot"). Those cases come back as typed failures:
 * youtube_blocked is retryable; everything here is in one file so the client
 * name/version (or a paid transcript API) can be swapped in one place.
 */
import { fingerprint } from "./fingerprint";
import { countLetters, normaliseText } from "./normalise";
import { fail, type ExtractFailure, type ExtractResult, type Span } from "./result";

export const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
export const INNERTUBE_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en", gl: "US" };
const ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
export const YOUTUBE_TIMEOUT_MS = 15_000;
const MAX_CAPTION_BYTES = 5 * 1024 * 1024;

export const NO_CAPTIONS = "This video has no English captions, so I can't make a quiz from it.";
export const VIDEO_UNAVAILABLE = "I couldn't open that video. It may be private, removed or age-restricted.";
export const YOUTUBE_BLOCKED = "YouTube didn't let me read that video just now. Try again in a few minutes.";

export type CaptionTrack = { baseUrl: string; languageCode: string; kind?: string; name?: string };
export type Cue = { startMs: number; durMs: number; text: string };

type PlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; lengthSeconds?: string; author?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: { baseUrl?: string; languageCode?: string; kind?: string; name?: { runs?: { text?: string }[] } }[];
    };
  };
};

export async function extractYouTube(videoId: string, fetchImpl: typeof fetch = fetch): Promise<ExtractResult> {
  const signal = AbortSignal.timeout(YOUTUBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(INNERTUBE_PLAYER_URL, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "user-agent": ANDROID_UA, "accept-language": "en-US,en" },
      body: JSON.stringify({ context: { client: INNERTUBE_CLIENT }, videoId }),
    });
    if (res.status === 429) return fail("youtube_blocked", YOUTUBE_BLOCKED, { retryable: true, detail: "player 429" });
    if (!res.ok) {
      return fail("youtube_unavailable", VIDEO_UNAVAILABLE, { retryable: res.status >= 500, detail: `player ${res.status}` });
    }
    const player = (await res.json()) as PlayerResponse;
    const unplayable = checkPlayability(player);
    if (unplayable) return unplayable;

    const track = pickTrack(captionTracks(player));
    if (!track) return fail("youtube_no_captions", NO_CAPTIONS);
    const trackUrl = captionUrl(track.baseUrl);
    if (!trackUrl) return fail("youtube_unavailable", VIDEO_UNAVAILABLE, { detail: "unexpected caption host" });

    const capRes = await fetchImpl(trackUrl, { signal, headers: { "user-agent": ANDROID_UA } });
    if (capRes.status === 429) return fail("youtube_blocked", YOUTUBE_BLOCKED, { retryable: true, detail: "timedtext 429" });
    if (!capRes.ok) return fail("youtube_unavailable", VIDEO_UNAVAILABLE, { retryable: true, detail: `timedtext ${capRes.status}` });
    const xml = await capRes.text();
    if (xml.length > MAX_CAPTION_BYTES) return fail("youtube_no_captions", NO_CAPTIONS, { detail: "captions too large" });

    const { text, spans } = captionsToText(parseCaptions(xml));
    // An empty body here is what a token-gated caption URL returns.
    if (countLetters(text) < 50) return fail("youtube_blocked", YOUTUBE_BLOCKED, { retryable: true, detail: "empty captions" });

    return {
      ok: true,
      kind: "youtube",
      text,
      fingerprint: await fingerprint(text),
      title: player.videoDetails?.title?.trim() || null,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      spans,
      meta: {
        videoId,
        captionLanguage: track.languageCode,
        captions: track.kind === "asr" ? "auto" : "manual",
        lengthSeconds: Number(player.videoDetails?.lengthSeconds ?? 0) || null,
        channel: player.videoDetails?.author ?? null,
      },
    };
  } catch (err) {
    return fail("youtube_blocked", YOUTUBE_BLOCKED, { retryable: true, detail: String(err).slice(0, 300) });
  }
}

/** Pure: null when the video can be read; otherwise why not. */
export function checkPlayability(player: PlayerResponse): ExtractFailure | null {
  const { status, reason = "" } = player.playabilityStatus ?? {};
  if (status === "OK") return null;
  if (/not a bot|unusual traffic/i.test(reason)) {
    return fail("youtube_blocked", YOUTUBE_BLOCKED, { retryable: true, detail: `${status}: ${reason}` });
  }
  return fail("youtube_unavailable", VIDEO_UNAVAILABLE, { detail: `${status}: ${reason}` });
}

function captionTracks(player: PlayerResponse): CaptionTrack[] {
  const raw = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return raw.flatMap((t) =>
    t.baseUrl && t.languageCode
      ? [{ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind, name: t.name?.runs?.[0]?.text }]
      : [],
  );
}

/** Pure: English only; uploaded before auto-generated ("asr"); plain "en" before "en-GB" etc. */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const english = tracks.filter((t) => /^en(-|$)/i.test(t.languageCode));
  const rank = (t: CaptionTrack) => (t.kind === "asr" ? 2 : 0) + (t.languageCode.toLowerCase() === "en" ? 0 : 1);
  return [...english].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Only ever fetch caption URLs on youtube.com; ask for srv3 explicitly. */
export function captionUrl(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl, "https://www.youtube.com");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/(^|\.)youtube\.com$/.test(url.hostname)) return null;
  url.searchParams.set("fmt", "srv3");
  return url.toString();
}

/** Pure: srv3 (<p t="ms" d="ms">…</p>) or the older format (<text start="s" dur="s">…</text>). */
export function parseCaptions(xml: string): Cue[] {
  const cues: Cue[] = [];
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = m[1] ?? "";
    cues.push({ startMs: numAttr(attrs, "t"), durMs: numAttr(attrs, "d"), text: cueText(m[2] ?? "") });
  }
  if (cues.length === 0) {
    for (const m of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      const attrs = m[1] ?? "";
      cues.push({
        startMs: Math.round(numAttr(attrs, "start") * 1000),
        durMs: Math.round(numAttr(attrs, "dur") * 1000),
        // The old format double-escapes: &amp;gt; → &gt; → >.
        text: cueText(decodeEntities(m[2] ?? "")),
      });
    }
  }
  return cues.filter((c) => c.text.length > 0);
}

function numAttr(attrs: string, name: string): number {
  const v = attrs.match(new RegExp(`\\b${name}="([\\d.]+)"`))?.[1];
  return v ? Number(v) : 0;
}

function cueText(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ""))
    .replace(/\[[A-Za-z][A-Za-z ]{0,30}\]|\u266A+/g, " ") // [Music], [Applause], ♪
    .replace(/(^|\s)>>(?=\s|$)/g, " ") // speaker change marker
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, ent: string) => {
    const e = ent.toLowerCase();
    if (e.startsWith("#x")) return safeCodePoint(parseInt(e.slice(2), 16), whole);
    if (e.startsWith("#")) return safeCodePoint(parseInt(e.slice(1), 10), whole);
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[e] ?? whole;
  });
}

function safeCodePoint(cp: number, fallback: string): string {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

const PARAGRAPH_GAP_MS = 2500;
const SOFT_PARAGRAPH_CHARS = 500;
const HARD_PARAGRAPH_CHARS = 1000;

/**
 * Pure: cues → paragraphs. A new paragraph starts after a pause of 2.5 s, or
 * once a paragraph passes 500 chars and a cue ends a sentence (1000 chars when
 * there is no punctuation, as in auto captions). Each paragraph gets a span
 * labelled with its start time.
 */
export function captionsToText(cues: Cue[]): { text: string; spans: Span[] } {
  const paragraphs: { startMs: number; parts: string[]; len: number }[] = [];
  let prevEnd = -Infinity;
  for (const cue of cues) {
    const current = paragraphs.at(-1);
    const lastPart = current?.parts.at(-1) ?? "";
    const breakHere =
      !current ||
      cue.startMs - prevEnd >= PARAGRAPH_GAP_MS ||
      (current.len >= SOFT_PARAGRAPH_CHARS && /[.!?]["')\]]?$/.test(lastPart)) ||
      current.len >= HARD_PARAGRAPH_CHARS;
    if (breakHere) paragraphs.push({ startMs: cue.startMs, parts: [cue.text], len: cue.text.length });
    else if (current) {
      current.parts.push(cue.text);
      current.len += cue.text.length + 1;
    }
    prevEnd = cue.startMs + cue.durMs;
  }

  const spans: Span[] = [];
  let text = "";
  for (const p of paragraphs) {
    const para = normaliseText(p.parts.join(" "));
    if (!para) continue;
    if (text) text += "\n\n";
    spans.push({ label: timestamp(p.startMs), start: text.length, end: text.length + para.length });
    text += para;
  }
  return { text, spans };
}

export function timestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

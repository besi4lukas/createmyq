import { describe, expect, it, vi } from "vitest";
import {
  captionsToText,
  captionUrl,
  checkPlayability,
  extractYouTube,
  NO_CAPTIONS,
  parseCaptions,
  pickTrack,
  timestamp,
  VIDEO_UNAVAILABLE,
  YOUTUBE_BLOCKED,
  type CaptionTrack,
} from "./youtube";

const track = (languageCode: string, kind?: string): CaptionTrack => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=x&lang=${languageCode}${kind ? "&kind=asr" : ""}`,
  languageCode,
  kind,
});

describe("pickTrack", () => {
  it("prefers uploaded English over auto-generated, and plain en over regional", () => {
    expect(pickTrack([track("en", "asr"), track("fr"), track("en-GB"), track("en")])?.languageCode).toBe("en");
    expect(pickTrack([track("en", "asr"), track("en-GB")])).toMatchObject({ languageCode: "en-GB", kind: undefined });
    expect(pickTrack([track("de"), track("en", "asr")])).toMatchObject({ languageCode: "en", kind: "asr" });
  });

  it("returns null without English", () => {
    expect(pickTrack([track("de"), track("es-ES")])).toBeNull();
    expect(pickTrack([])).toBeNull();
  });
});

describe("parseCaptions", () => {
  it("reads srv3, including auto captions' word segments", () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>
<p t="1640" d="2880">&gt;&gt; hello, come in and sit
down.</p>
<p t="4520" d="1000">[Music]</p>
<p t="5520" d="3000" w="1"><s ac="0">so</s><s t="320" ac="0"> the</s><s t="600"> event</s><s t="900"> loop</s></p>
<p t="8520" d="10" a="1">
</p>
<p t="9000" d="500">it&#39;s &amp; &#x27;fine&#x27; &lt;3 \u266A</p>
</body></timedtext>`;
    expect(parseCaptions(xml)).toEqual([
      { startMs: 1640, durMs: 2880, text: "hello, come in and sit down." },
      { startMs: 5520, durMs: 3000, text: "so the event loop" },
      { startMs: 9000, durMs: 500, text: "it's & 'fine' <3" },
    ]);
  });

  it("reads the older <text start dur> format, double-escaped", () => {
    const xml = `<transcript><text start="1.64" dur="2.88">&amp;gt;&amp;gt; it&amp;#39;s here</text><text start="4.5" dur="1">next</text></transcript>`;
    expect(parseCaptions(xml)).toEqual([
      { startMs: 1640, durMs: 2880, text: "it's here" },
      { startMs: 4500, durMs: 1000, text: "next" },
    ]);
  });
});

describe("captionsToText", () => {
  it("starts a paragraph after a pause and labels it with its start time", () => {
    const { text, spans } = captionsToText([
      { startMs: 0, durMs: 1000, text: "First sentence." },
      { startMs: 1000, durMs: 1000, text: "Same paragraph." },
      { startMs: 65_000, durMs: 1000, text: "After a pause." },
    ]);
    expect(text).toBe("First sentence. Same paragraph.\n\nAfter a pause.");
    expect(spans).toEqual([
      { label: "0:00", start: 0, end: 31 },
      { label: "1:05", start: 33, end: 47 },
    ]);
  });

  it("splits long unpunctuated runs (auto captions) at 1000 chars", () => {
    const cues = Array.from({ length: 100 }, (_, i) => ({ startMs: i * 1000, durMs: 1000, text: "word ".repeat(5).trim() }));
    const { text, spans } = captionsToText(cues);
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(1030);
    expect(text.replace(/\s+/g, " ").split(" ").length).toBe(500);
  });

  it("formats timestamps", () => {
    expect([timestamp(0), timestamp(61_000), timestamp(3_725_000)]).toEqual(["0:00", "1:01", "1:02:05"]);
  });
});

describe("checkPlayability / captionUrl", () => {
  it("maps statuses to typed failures", () => {
    expect(checkPlayability({ playabilityStatus: { status: "OK" } })).toBeNull();
    expect(
      checkPlayability({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you\u2019re not a bot" } }),
    ).toMatchObject({ code: "youtube_blocked", retryable: true });
    expect(checkPlayability({ playabilityStatus: { status: "ERROR", reason: "This video is unavailable" } })).toMatchObject({
      code: "youtube_unavailable",
      message: VIDEO_UNAVAILABLE,
      retryable: false,
    });
  });

  it("only fetches caption URLs on youtube.com, as srv3", () => {
    expect(captionUrl("https://www.youtube.com/api/timedtext?v=x&fmt=json3")).toBe(
      "https://www.youtube.com/api/timedtext?v=x&fmt=srv3",
    );
    expect(captionUrl("/api/timedtext?v=x")).toBe("https://www.youtube.com/api/timedtext?v=x&fmt=srv3");
    expect(captionUrl("https://evil.example/api/timedtext")).toBeNull();
    expect(captionUrl("http://www.youtube.com/api/timedtext")).toBeNull();
  });
});

describe("extractYouTube", () => {
  const player = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
  const ok = (tracks: object[]) => ({
    playabilityStatus: { status: "OK" },
    videoDetails: { title: "What the heck is the event loop anyway?", lengthSeconds: "1584", author: "JSConf" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  });
  const captions = `<timedtext format="3"><body>${Array.from(
    { length: 20 },
    (_, i) => `<p t="${i * 2000}" d="2000">The call stack runs one frame at a time, line ${i}.</p>`,
  ).join("")}</body></timedtext>`;

  it("returns the transcript with title, metadata and spans", async () => {
    const f = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("youtubei")
        ? player(ok([{ baseUrl: "https://www.youtube.com/api/timedtext?v=8aGhZQkoFbQ&lang=en", languageCode: "en" }]))
        : new Response(captions),
    ) as unknown as typeof fetch;
    const r = await extractYouTube("8aGhZQkoFbQ", f);
    if (!r.ok) throw new Error(r.message);
    expect(r).toMatchObject({
      kind: "youtube",
      title: "What the heck is the event loop anyway?",
      url: "https://www.youtube.com/watch?v=8aGhZQkoFbQ",
      meta: { videoId: "8aGhZQkoFbQ", captions: "manual", captionLanguage: "en", lengthSeconds: 1584 },
    });
    expect(r.text.startsWith("The call stack runs one frame at a time, line 0.")).toBe(true);
    expect(r.fingerprint).toMatch(/^v1:/);
  });

  it("fails clearly without English captions", async () => {
    const f = (async () => player(ok([]))) as unknown as typeof fetch;
    expect(await extractYouTube("aaaaaaaaaaa", f)).toEqual({
      ok: false,
      code: "youtube_no_captions",
      message: NO_CAPTIONS,
      retryable: false,
    });
    const german = (async () =>
      player(ok([{ baseUrl: "https://www.youtube.com/api/timedtext?lang=de", languageCode: "de" }]))) as unknown as typeof fetch;
    expect(await extractYouTube("aaaaaaaaaaa", german)).toMatchObject({ code: "youtube_no_captions" });
  });

  it("treats rate limiting, network errors and empty caption bodies as retryable blocks", async () => {
    const limited = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    expect(await extractYouTube("aaaaaaaaaaa", limited)).toMatchObject({ code: "youtube_blocked", retryable: true, message: YOUTUBE_BLOCKED });
    const down = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    expect(await extractYouTube("aaaaaaaaaaa", down)).toMatchObject({ code: "youtube_blocked", retryable: true });
    const empty = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("youtubei")
        ? player(ok([{ baseUrl: "https://www.youtube.com/api/timedtext?lang=en", languageCode: "en" }]))
        : new Response(""),
    ) as unknown as typeof fetch;
    expect(await extractYouTube("aaaaaaaaaaa", empty)).toMatchObject({ code: "youtube_blocked", retryable: true });
  });
});

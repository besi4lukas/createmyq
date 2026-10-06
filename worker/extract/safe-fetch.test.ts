import { describe, expect, it, vi } from "vitest";
import { decodeBody, safeFetch } from "./safe-fetch";

const opts = { timeoutMs: 1000, maxBytes: 100 };

function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as unknown as typeof fetch;
}

describe("safeFetch", () => {
  it("follows redirects by hand and reports the final URL", async () => {
    const f = fakeFetch({
      "https://a.example/": () => new Response(null, { status: 301, headers: { location: "/b" } }),
      "https://a.example/b": () => new Response("hello", { headers: { "content-type": "text/html" } }),
    });
    const r = await safeFetch("https://a.example/", { ...opts, fetchImpl: f });
    expect(r).toMatchObject({ ok: true, url: "https://a.example/b", contentType: "text/html" });
  });

  it("refuses a redirect to a private address", async () => {
    const f = fakeFetch({
      "https://a.example/": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    expect(await safeFetch("https://a.example/", { ...opts, fetchImpl: f })).toMatchObject({ ok: false, code: "blocked_url" });
  });

  it("gives up after 5 redirects", async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/again" } })) as unknown as typeof fetch;
    expect(await safeFetch("https://a.example/", { ...opts, fetchImpl: f })).toMatchObject({ ok: false, code: "fetch_failed" });
    expect(f).toHaveBeenCalledTimes(6);
  });

  it("caps the body, declared or streamed", async () => {
    const declared = fakeFetch({
      "https://a.example/": () => new Response("x", { headers: { "content-length": "101" } }),
    });
    expect(await safeFetch("https://a.example/", { ...opts, fetchImpl: declared })).toMatchObject({ ok: false, code: "too_large" });
    const streamed = fakeFetch({ "https://a.example/": () => new Response("x".repeat(101)) });
    expect(await safeFetch("https://a.example/", { ...opts, fetchImpl: streamed })).toMatchObject({ ok: false, code: "too_large" });
    const fits = fakeFetch({ "https://a.example/": () => new Response("x".repeat(100)) });
    expect(await safeFetch("https://a.example/", { ...opts, fetchImpl: fits })).toMatchObject({ ok: true });
  });

  it("marks 5xx and 429 retryable, 404 not", async () => {
    for (const [status, retryable] of [[404, false], [429, true], [503, true]] as const) {
      const f = fakeFetch({ "https://a.example/": () => new Response("no", { status }) });
      expect(await safeFetch("https://a.example/", { ...opts, fetchImpl: f })).toMatchObject({
        ok: false,
        code: "fetch_failed",
        retryable,
      });
    }
  });

  it("times out", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const r = await safeFetch("https://a.example/", { timeoutMs: 20, maxBytes: 100, fetchImpl: hang });
    expect(r).toMatchObject({ ok: false, code: "fetch_failed", retryable: true, detail: "timeout after 20 ms" });
  });
});

describe("decodeBody", () => {
  it("uses the declared charset and falls back to UTF-8", () => {
    expect(decodeBody(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "text/html; charset=ISO-8859-1")).toBe("caf\u00E9");
    expect(decodeBody(new TextEncoder().encode("caf\u00E9"), "text/html")).toBe("caf\u00E9");
    expect(decodeBody(new TextEncoder().encode("ok"), "text/html; charset=nonsense")).toBe("ok");
  });
});

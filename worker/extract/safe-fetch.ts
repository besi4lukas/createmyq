/**
 * STM-14: fetch a user-supplied URL carefully. Redirects are followed by hand
 * (at most MAX_REDIRECTS), and every hop goes through checkFetchTarget, so a
 * public page can't bounce us to localhost. The whole fetch has one deadline,
 * and the body is read as a stream and abandoned past `maxBytes`.
 */
import { fail, type ExtractFailure } from "./result";
import { checkFetchTarget } from "./source-url";

export const MAX_REDIRECTS = 5;
export const FETCH_FAILED = "I couldn't load that page. Check the link and try again.";

export type Fetched = { ok: true; url: string; contentType: string; bytes: Uint8Array };

export type FetchOptions = {
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
};

export async function safeFetch(start: string, opts: FetchOptions): Promise<Fetched | ExtractFailure> {
  const doFetch = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = new URL(start);
  try {
    for (let hop = 0; ; hop++) {
      const blocked = checkFetchTarget(url);
      if (blocked) return blocked;
      const res = await doFetch(url.toString(), { redirect: "manual", signal, headers: opts.headers });
      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) return fail("fetch_failed", FETCH_FAILED, { detail: "too many redirects" });
        url = new URL(res.headers.get("location") ?? "", url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        // 404/410 won't fix themselves; 429 and 5xx might.
        const retryable = res.status === 429 || res.status >= 500;
        return fail("fetch_failed", FETCH_FAILED, { retryable, detail: `status ${res.status}` });
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > opts.maxBytes) {
        await res.body?.cancel();
        return tooBig(opts.maxBytes);
      }
      const bytes = await readCapped(res, opts.maxBytes);
      if (!bytes) return tooBig(opts.maxBytes);
      return { ok: true, url: url.toString(), contentType: res.headers.get("content-type") ?? "", bytes };
    }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return fail("fetch_failed", FETCH_FAILED, {
      retryable: true,
      detail: timedOut ? `timeout after ${opts.timeoutMs} ms` : String(err),
    });
  }
}

function tooBig(maxBytes: number): ExtractFailure {
  const mb = Math.round(maxBytes / (1024 * 1024));
  return fail("too_large", `That page is over ${mb} MB, too big to read.`);
}

/** The body, or null as soon as it passes `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Decode with the charset the server declared, falling back to UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Dev-only: run worker/extract inside workerd (see wrangler.jsonc next to this
 * file for how to start it). Not part of the app and never deployed.
 *
 *   curl --data-binary @some.pdf localhost:8799/          → PDF
 *   curl 'localhost:8799/?url=https://youtu.be/<id>'      → article or YouTube
 *
 * Answers with what the Workflow would get: ok/code/message, char count,
 * fingerprint, spans, meta and the first `chars` (default 300) characters.
 */
import { extractSource, parseSourceUrl, type ExtractResult } from "../../worker/extract";

async function run(req: Request): Promise<ExtractResult> {
  if (req.method === "POST") return extractSource({ kind: "pdf", bytes: new Uint8Array(await req.arrayBuffer()) });
  const target = new URL(req.url).searchParams.get("url") ?? "";
  const parsed = parseSourceUrl(target);
  if ("ok" in parsed) return parsed;
  return extractSource({ kind: parsed.kind, url: target });
}

export default {
  async fetch(req: Request): Promise<Response> {
    const chars = Number(new URL(req.url).searchParams.get("chars") ?? "300");
    const started = Date.now();
    const r = await run(req);
    const ms = Date.now() - started;
    if (!r.ok) return Response.json({ ...r, ms, runtime: navigator.userAgent }, { status: 422 });
    return Response.json({
      ok: true,
      kind: r.kind,
      title: r.title,
      url: r.url,
      chars: r.text.length,
      fingerprint: r.fingerprint,
      spans: r.spans.length,
      meta: r.meta,
      ms,
      runtime: navigator.userAgent,
      sample: r.text.slice(0, chars),
    });
  },
};

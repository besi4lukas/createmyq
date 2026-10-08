/**
 * Dev-only: run the STM-21 classifiers inside workerd with their real
 * backends, for scripts/eval/bench.ts (see wrangler.jsonc next to this file).
 * Not part of the app and never deployed.
 *
 *   POST /classify {"kind": "embedding"|"model"|"fallback", "samples": [...], "threshold"?: 0.75}
 *     → {"ok": true, "result": Classification, "ms": n} | {"ok": false, "error": "...", "ms": n}
 *
 * A fresh classifier per request, as in a Workflow step (labels are embedded
 * every time), so latency is what the gate would see minus the network hop.
 */
import { classifierFor, type ClassifierEnv } from "../../worker/classifier/backends";
import { CLASSIFIER_KINDS, type ClassifierKind } from "../../worker/classifier/index";

type Body = { kind: ClassifierKind; samples: string[]; threshold?: number };

export default {
  async fetch(req: Request, env: ClassifierEnv): Promise<Response> {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/classify") return new Response("not found", { status: 404 });
    const body = (await req.json()) as Body;
    if (!CLASSIFIER_KINDS.includes(body.kind) || !Array.isArray(body.samples)) return Response.json({ ok: false, error: "bad request" }, { status: 400 });
    const started = Date.now();
    try {
      const result = await classifierFor(env, body.kind, body.threshold).classify(body.samples);
      return Response.json({ ok: true, result, ms: Date.now() - started });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started }, { status: 502 });
    }
  },
};

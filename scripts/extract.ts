/**
 * Run STM-14 extraction on one source and print what the Workflow would get.
 * Dev/operator only: nothing is written anywhere unless --out is given.
 *
 *   npm run extract -- ./some.pdf
 *   npm run extract -- https://martinfowler.com/articles/microservices.html
 *   npm run extract -- https://youtu.be/8aGhZQkoFbQ --out /tmp/transcript.txt
 *
 * Same code as the Worker (worker/extract), run in Node. To check it inside
 * workerd, use scripts/extract-harness (see its header).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { extractSource, parseSourceUrl, type ExtractResult } from "../worker/extract";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, chars: { type: "string", default: "300" } },
});
const target = positionals[0];
if (!target) {
  console.error("usage: npm run extract -- <file.pdf | url> [--out text.txt] [--chars 300]");
  process.exit(2);
}

async function run(t: string): Promise<ExtractResult> {
  if (/^https?:\/\//i.test(t)) {
    const parsed = parseSourceUrl(t);
    if ("ok" in parsed) return parsed;
    return extractSource({ kind: parsed.kind, url: t });
  }
  return extractSource({ kind: "pdf", bytes: new Uint8Array(readFileSync(t)) });
}

const started = Date.now();
const result = await run(target);
const ms = Date.now() - started;
if (!result.ok) {
  console.log(JSON.stringify({ ok: false, code: result.code, message: result.message, retryable: result.retryable, detail: result.detail, ms }, null, 2));
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      ok: true,
      kind: result.kind,
      title: result.title,
      url: result.url,
      chars: result.text.length,
      fingerprint: result.fingerprint,
      spans: result.spans.length,
      firstSpans: result.spans.slice(0, 3),
      meta: result.meta,
      ms,
    },
    null,
    2,
  ),
);
console.log(`--- first ${values.chars} chars ---`);
console.log(result.text.slice(0, Number(values.chars)));
if (values.out) {
  writeFileSync(values.out, result.text);
  console.log(`--- full text written to ${values.out} ---`);
}

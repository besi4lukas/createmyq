/**
 * STM-20: load the whole evaluation set and report on it.
 *
 *   npm run eval:check                 # load everything (fetch entries: cache, else network)
 *   npm run eval:check -- --offline    # no network: an uncached fetch entry fails
 *   npm run eval:check -- --refresh    # re-extract every fetch entry
 *   npm run eval:check -- --show <id> [--show <id> …]   # also print text and samples
 *
 * Exits 1 if the manifest is invalid, the set is not 25/25, or any entry's
 * text can't be loaded or chunked.
 */
import { parseArgs } from "node:util";
import { loadEvalSet, type EvalEntry } from "./load";

const { values } = parseArgs({
  options: {
    offline: { type: "boolean", default: false },
    refresh: { type: "boolean", default: false },
    show: { type: "string", multiple: true, default: [] },
    chars: { type: "string", default: "200" },
  },
});

const started = Date.now();
let loaded: Awaited<ReturnType<typeof loadEvalSet>>;
try {
  loaded = await loadEvalSet({ offline: values.offline, refresh: values.refresh });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const { entries, failures } = loaded;
const total = entries.length + failures.length;

function table(title: string, key: (e: EvalEntry) => string): void {
  const rows = new Map<string, { accepted: number; refused: number }>();
  for (const e of entries) {
    const row = rows.get(key(e)) ?? { accepted: 0, refused: 0 };
    row[e.label]++;
    rows.set(key(e), row);
  }
  console.log(`\n${title}`);
  const width = Math.max(...[...rows.keys()].map((k) => k.length), 10);
  console.log(`  ${"".padEnd(width)}  accepted  refused`);
  for (const [k, r] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${k.padEnd(width)}  ${String(r.accepted).padStart(8)}  ${String(r.refused).padStart(7)}`);
  }
}

console.log(`Evaluation set: ${total} entries, ${entries.length} loaded, ${failures.length} failed (${Date.now() - started} ms)`);
table("By label", (e) => e.label);
table("By kind", (e) => e.kind);
table("By difficulty", (e) => e.difficulty);
table("By storage / origin this run", (e) => `${e.storage} (${e.origin})`);
table("By topic", (e) => e.topic);

const chars = entries.map((e) => e.text.length).sort((a, b) => a - b);
const chunks = entries.map((e) => e.chunks.length).sort((a, b) => a - b);
const mid = (xs: number[]) => xs[Math.floor(xs.length / 2)] ?? 0;
console.log(`\nText chars: min ${chars[0] ?? 0}, median ${mid(chars)}, max ${chars.at(-1) ?? 0}`);
console.log(`Chunks: min ${chunks[0] ?? 0}, median ${mid(chunks)}, max ${chunks.at(-1) ?? 0}`);

const ambiguous = entries.filter((e) => e.ambiguous);
console.log(`\nAmbiguous (proposed label, awaiting a human ruling): ${ambiguous.length}`);
for (const e of ambiguous) console.log(`  ${e.id}: proposed ${e.label}`);
const synthetic = entries.filter((e) => e.synthetic);
console.log(`Synthetic: ${synthetic.length}${synthetic.length ? ` (${synthetic.map((e) => e.id).join(", ")})` : ""}`);

const n = Number(values.chars);
for (const id of values.show) {
  const e = entries.find((x) => x.id === id);
  if (!e) {
    console.log(`\n--- ${id}: not loaded`);
    continue;
  }
  console.log(`\n--- ${e.id} ---`);
  console.log(`title:    ${e.title}`);
  console.log(`label:    ${e.label}${e.detected ? `, detected "${e.detected}"` : ""}${e.ambiguous ? " (ambiguous)" : ""}`);
  console.log(`kind:     ${e.kind}, ${e.difficulty}, topic ${e.topic}`);
  console.log(`licence:  ${e.source.licence}, ${e.storage} (${e.origin}); ${e.source.citation}`);
  console.log(`text:     ${e.text.length} chars, ${e.chunks.length} chunks`);
  console.log(`first ${n} chars: ${JSON.stringify(e.text.slice(0, n))}`);
  for (const s of e.samples) {
    const where = [s.chunk.headingPath.join(" › "), s.chunk.location].filter(Boolean).join(", ");
    console.log(`  ${s.position} (#${s.chunk.ordinal}${where ? `, ${where}` : ""}): ${JSON.stringify(s.text.slice(0, 120))}`);
  }
}

if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  ✖ ${f.id}: ${f.message}`);
  process.exit(1);
}
console.log("\nOK");

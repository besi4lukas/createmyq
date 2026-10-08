/**
 * STM-21: benchmark the topic gate's classifiers on the evaluation set
 * (STM-20) for accuracy, latency and cost.
 *
 *   npx wrangler dev -c scripts/classifier-harness/wrangler.jsonc --port 8798   # in another terminal
 *   npm run eval:bench                                  # all three
 *   npm run eval:bench -- --classifier embedding        # or model | fallback | all
 *   npm run eval:bench -- --classifier fallback --threshold 0.8
 *   npm run eval:bench -- --only se-article-wiki-rust --only off-pdf-nhlbi-cookbook
 *   npm run eval:bench -- --offline                     # fetch entries from the cache only
 *   npm run eval:bench -- --report fixtures/eval/.runs/<run>.json   # re-score a saved run, no calls
 *
 * The classifiers run inside workerd (scripts/classifier-harness) with their
 * real backends, because the Workers AI binding can't be reached from Node.
 * Every call is billed: about $0.005 per source for Haiku, ~$0.00006 for
 * embeddings. Each entry is classified on its start/middle/end samples, the
 * same input STM-22's gate reads.
 *
 * Writes fixtures/eval/.runs/<timestamp>.json (every result) and .md (the
 * report, also printed). The directory is gitignored; the summary of the
 * final run is committed as fixtures/eval/results/STM-21.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CLASSIFIER_KINDS, FALLBACK_THRESHOLD, type ClassifierKind } from "../../worker/classifier/index";
import type { Classification } from "../../worker/classifier/types";
import { EVAL_DIR, loadEvalSet, type EvalEntry } from "./load";
import {
  accuracy,
  chooseThreshold,
  confusion,
  detectedMatches,
  detectedRate,
  isCorrect,
  leaveOneOut,
  percentile,
  sweep,
  type BenchRow,
  type SweepInput,
} from "./metrics";

const { values } = parseArgs({
  options: {
    classifier: { type: "string", default: "all" },
    threshold: { type: "string" },
    only: { type: "string", multiple: true },
    offline: { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
    harness: { type: "string", default: process.env.CLASSIFIER_HARNESS_URL ?? "http://localhost:8798" },
    report: { type: "string" },
  },
});

type Run = {
  startedAt: string;
  threshold: number;
  entries: number;
  classifiers: Partial<Record<ClassifierKind, BenchRow[]>>;
};

const RUNS_DIR = join(EVAL_DIR, ".runs");

function pick(): ClassifierKind[] {
  if (values.classifier === "all") return [...CLASSIFIER_KINDS];
  if ((CLASSIFIER_KINDS as readonly string[]).includes(values.classifier)) return [values.classifier as ClassifierKind];
  console.error(`--classifier must be one of ${CLASSIFIER_KINDS.join(", ")}, all`);
  process.exit(2);
}

async function classifyOne(kind: ClassifierKind, e: EvalEntry, threshold: number): Promise<BenchRow> {
  const base = { id: e.id, label: e.label, ambiguous: e.ambiguous, detected: e.detected, detectedSynonyms: e.detectedSynonyms ?? [] };
  const samples = e.samples.map((s) => s.text);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${values.harness}/classify`, { method: "POST", body: JSON.stringify({ kind, samples, threshold }) });
      const body = (await res.json()) as { ok: true; result: Classification; ms: number } | { ok: false; error: string; ms: number };
      if (body.ok) return { ...base, result: body.result, error: null, ms: body.ms };
      if (attempt >= 2) return { ...base, result: null, error: body.error, ms: body.ms };
    } catch (err) {
      if (attempt >= 2) return { ...base, result: null, error: err instanceof Error ? err.message : String(err), ms: 0 };
    }
  }
}

async function runAll(kind: ClassifierKind, entries: EvalEntry[], threshold: number): Promise<BenchRow[]> {
  const rows: BenchRow[] = new Array(entries.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      rows[i] = await classifyOne(kind, entries[i]!, threshold);
      done++;
      process.stderr.write(`\r${kind}: ${done}/${entries.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
  process.stderr.write("\n");
  return rows;
}

// ---------------------------------------------------------------------------
// Report

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const frac = (a: { correct: number; total: number; rate: number }) => `${pct(a.rate)} (${a.correct}/${a.total})`;
const usd = (x: number) => `$${x < 0.01 ? x.toFixed(5) : x.toFixed(4)}`;
const fmtConf = (c: number) => c.toFixed(2);

function verdictCell(r: BenchRow | undefined): string {
  if (!r) return "–";
  if (!r.result) return `error`;
  const res = r.result;
  return `${res.verdict} ${fmtConf(res.confidence)}${res.detected ? ` "${res.detected}"` : ""}${res.primary ? " (via model)" : ""}`;
}

function report(run: Run): string {
  const out: string[] = [];
  const kinds = CLASSIFIER_KINDS.filter((k) => run.classifiers[k]);
  out.push(`# Classifier benchmark (${run.startedAt})`, "");
  out.push(`${run.entries} entries; fallback threshold ${run.threshold}. Accuracy: unambiguous (the 90% gate) / ambiguous (proposed labels) / overall.`, "");

  out.push(
    "| Classifier | Unambiguous | Ambiguous | Overall | Refused P | Refused R | Detected match | p50 | p95 | Tokens in/out | Embedded chars | $/source | $/1k sources | → Haiku |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const k of kinds) {
    const rows = run.classifiers[k]!;
    const ok = rows.filter((r) => r.result);
    const unamb = rows.filter((r) => !r.ambiguous);
    const c = confusion(unamb);
    const d = detectedRate(rows);
    const ms = ok.map((r) => r.ms);
    const tin = ok.reduce((n, r) => n + r.result!.usage.inputTokens, 0);
    const tout = ok.reduce((n, r) => n + r.result!.usage.outputTokens, 0);
    const chars = ok.reduce((n, r) => n + r.result!.usage.embeddedChars, 0);
    const cost = ok.reduce((n, r) => n + r.result!.costUsd, 0) / Math.max(1, ok.length);
    const fell = ok.filter((r) => r.result!.primary).length;
    out.push(
      `| ${k} | ${frac(accuracy(rows, "unambiguous", isCorrect))} | ${frac(accuracy(rows, "ambiguous", isCorrect))} | ${frac(accuracy(rows, "overall", isCorrect))} | ${pct(c.refusedPrecision)} | ${pct(c.refusedRecall)} | ${frac({ correct: d.matched, total: d.total, rate: d.rate })} | ${percentile(ms, 50)} ms | ${percentile(ms, 95)} ms | ${tin}/${tout} | ${chars} | ${usd(cost)} | ${usd(cost * 1000)} | ${k === "fallback" ? `${pct(fell / Math.max(1, ok.length))} (${fell})` : k === "model" ? "100%" : "0%"} |`,
    );
  }
  out.push("", "Refused P/R are on the unambiguous entries, refused = positive. Detected match: refused entries predicted refused whose phrase matches the expected one or a synonym (scripts/eval/metrics.ts `detectedMatches`).", "");

  out.push("## Confusion (unambiguous entries)", "", "| Classifier | refused→refused | accepted→refused (blocked) | refused→accepted (let through) | accepted→accepted | errors |", "|---|---|---|---|---|---|");
  for (const k of kinds) {
    const c = confusion(run.classifiers[k]!.filter((r) => !r.ambiguous));
    out.push(`| ${k} | ${c.tp} | ${c.fp} | ${c.fn} | ${c.tn} | ${c.errors} |`);
  }
  out.push("");

  const byId = (k: ClassifierKind) => new Map((run.classifiers[k] ?? []).map((r) => [r.id, r]));
  const maps = Object.fromEntries(kinds.map((k) => [k, byId(k)])) as Record<ClassifierKind, Map<string, BenchRow>>;
  const anyRows = run.classifiers[kinds[0]!]!;
  const ambiguous = anyRows.filter((r) => r.ambiguous);
  if (ambiguous.length > 0) {
    out.push("## Ambiguous entries (proposed labels, awaiting a ruling)", "", `| Entry | Proposed | ${kinds.join(" | ")} |`, `|---|---|${kinds.map(() => "---").join("|")}|`);
    for (const r of ambiguous) out.push(`| ${r.id} | ${r.label} | ${kinds.map((k) => verdictCell(maps[k]?.get(r.id))).join(" | ")} |`);
    out.push("");
  }

  const emb = run.classifiers.embedding;
  const mod = run.classifiers.model;
  if (emb && mod) {
    const modById = new Map(mod.map((r) => [r.id, r]));
    const inputs: SweepInput[] = emb.flatMap((r) => {
      const m = modById.get(r.id);
      if (!r.result || !m?.result) return [];
      return [
        {
          id: r.id,
          label: r.label,
          ambiguous: r.ambiguous,
          embedding: { verdict: r.result.verdict, confidence: r.result.confidence, costUsd: r.result.costUsd },
          model: { verdict: m.result.verdict, costUsd: m.result.costUsd },
        },
      ];
    });
    const rows = sweep(inputs);
    const chosen = chooseThreshold(inputs);
    const loo = leaveOneOut(inputs);
    const chosenRow = rows.find((r) => r.threshold === chosen)!;
    out.push(
      "## Fallback threshold sweep (simulated from the embedding and model runs)",
      "",
      "Embedding confidence ≥ t keeps the embedding verdict; below t the model's verdict is used. Confidence = 0.5 + 0.5·min(1, |margin| / 0.1); t = 0.5 never falls through, 1.01 always does.",
      "",
      "| t | Unambiguous | Ambiguous | Overall | → Haiku | $/source |",
      "|---|---|---|---|---|---|",
    );
    for (const r of rows) {
      out.push(`| ${r.threshold}${r.threshold === chosen ? " ◀" : ""} | ${frac(r.unambiguous)} | ${frac(r.ambiguous)} | ${frac(r.overall)} | ${pct(r.fallbackRate)} | ${usd(r.costPerSource)} |`);
    }
    const ts = [...new Set(loo.thresholds)].sort((a, b) => a - b);
    out.push(
      "",
      `Chosen by the rule "highest unambiguous accuracy, ties to the lowest t": **t = ${chosen}**, in-sample ${frac(chosenRow.unambiguous)} unambiguous, ${pct(chosenRow.fallbackRate)} to Haiku.`,
      `Leave-one-out (choose t on the other ${loo.total - 1} unambiguous entries, score the held-out one, ×${loo.total}): **${frac(loo)}** unambiguous; thresholds chosen across folds: ${ts.join(", ")}.`,
    );
    const flat = new Set(rows.map((r) => r.unambiguous.correct)).size === 1;
    if (flat) out.push("Every threshold gives the same unambiguous accuracy, so this set cannot choose the threshold; the rule then falls to its tie-break.");
    const closest = emb
      .filter((r) => !r.ambiguous && r.result?.embedding)
      .sort((a, b) => Math.abs(a.result!.embedding!.margin) - Math.abs(b.result!.embedding!.margin))
      .slice(0, 3)
      .map((r) => `${r.id} ${r.result!.embedding!.margin.toFixed(3)}`);
    out.push(`Smallest |margin| among unambiguous entries: ${closest.join(", ")}.`, "");
  }

  out.push("## Misses", "");
  for (const k of kinds) {
    const misses = run.classifiers[k]!.filter((r) => !isCorrect(r));
    out.push(`### ${k} (${misses.length})`, "");
    if (misses.length === 0) {
      out.push("None.", "");
      continue;
    }
    out.push("| Entry | Label | Ambiguous | Predicted | Confidence | Detected | Margin | Decided by |", "|---|---|---|---|---|---|---|---|");
    for (const r of misses) {
      const res = r.result;
      out.push(
        `| ${r.id} | ${r.label} | ${r.ambiguous ? "yes" : ""} | ${res ? res.verdict : `error: ${r.error}`} | ${res ? fmtConf(res.confidence) : ""} | ${res?.detected ?? ""} | ${res?.embedding ? res.embedding.margin.toFixed(3) : ""} | ${res?.by ?? ""} |`,
      );
    }
    out.push("");
  }

  out.push("## Detected phrases that did not match", "");
  for (const k of kinds) {
    const bad = run.classifiers[k]!.filter(
      (r) => r.label === "refused" && r.result?.verdict === "refused" && !detectedMatches(r.result.detected ?? "", [r.detected!, ...r.detectedSynonyms]),
    );
    out.push(`- **${k}**: ${bad.length === 0 ? "none" : bad.map((r) => `${r.id} said "${r.result!.detected}" (expected "${r.detected}")`).join("; ")}`);
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------

let run: Run;
if (values.report) {
  run = JSON.parse(await readFile(values.report, "utf8")) as Run;
} else {
  const threshold = values.threshold !== undefined ? Number(values.threshold) : FALLBACK_THRESHOLD;
  const { entries, failures } = await loadEvalSet({ offline: values.offline, only: values.only });
  if (failures.length > 0) {
    for (const f of failures) console.error(`✖ ${f.id}: ${f.message}`);
    process.exit(1);
  }
  try {
    await fetch(values.harness, { method: "GET" });
  } catch {
    console.error(`The harness is not running at ${values.harness}. Start it with:\n  npx wrangler dev -c scripts/classifier-harness/wrangler.jsonc --port 8798`);
    process.exit(1);
  }
  run = { startedAt: new Date().toISOString(), threshold, entries: entries.length, classifiers: {} };
  for (const kind of pick()) run.classifiers[kind] = await runAll(kind, entries, threshold);
  await mkdir(RUNS_DIR, { recursive: true });
  const stamp = run.startedAt.replace(/[:.]/g, "-");
  await writeFile(join(RUNS_DIR, `${stamp}.json`), JSON.stringify(run, null, 2));
  await writeFile(join(RUNS_DIR, `${stamp}.md`), report(run));
  console.error(`wrote ${join(RUNS_DIR, `${stamp}.json`)} and .md`);
}
console.log(report(run));

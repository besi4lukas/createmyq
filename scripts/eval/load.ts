/**
 * STM-20: load the gate's evaluation set with each entry's text, chunks and
 * start/middle/end samples, ready for a classifier benchmark (STM-21).
 *
 *   const { entries, failures } = await loadEvalSet();
 *   for (const e of entries) classify(e.samples.map((s) => s.text));
 *
 * Text comes from one of two places (manifest `storage`):
 *   repo   fixtures/eval/text/<id>.txt, committed. Written by snapshot.ts from
 *          the real source with the Worker's own extractor, so it is exactly
 *          what the Workflow's Extract step would produce (minus page spans).
 *   fetch  extracted from `source.url` on first use with the same extractor
 *          and cached in fixtures/eval/.cache/<id>.json (gitignored). Needs
 *          the network once; `offline` turns a cache miss into a failure.
 *
 * Chunks are STM-17's chunkSource(); samples are the first, middle and last
 * chunk, the input STM-22's gate will read.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkSource, type Chunk } from "../../worker/chunk";
import { sampleChunks, type Sample } from "../../worker/chunk/sample";
import { extractSource, type ExtractResult, type Span } from "../../worker/extract";
import { fingerprint } from "../../worker/extract/fingerprint";
import { evalManifestSchema, setProblems, type EvalManifest, type EvalManifestEntry } from "./manifest";
import { z } from "zod";

export const EVAL_DIR = fileURLToPath(new URL("../../fixtures/eval/", import.meta.url));

export const textPath = (dir: string, id: string) => join(dir, "text", `${id}.txt`);
export const cachePath = (dir: string, id: string) => join(dir, ".cache", `${id}.json`);

// The sampler lives with the chunker so the Workflow (STM-22) uses the same one.
export { sampleChunks, type Sample, type SamplePosition } from "../../worker/chunk/sample";

export type EvalEntry = EvalManifestEntry & {
  text: string;
  /** Extracted title (the page/PDF/video's own), which may differ from the manifest's. */
  extractedTitle: string | null;
  /** PDF pages / caption paragraphs for fetched entries; empty for repo text. */
  spans: Span[];
  fingerprint: string;
  chunks: Chunk[];
  samples: Sample[];
  /** Where the text came from on this load. */
  origin: "repo" | "cache" | "network";
};

export type LoadFailure = { id: string; message: string };

export type LoadOptions = {
  dir?: string;
  /** Never touch the network: an uncached fetch entry is a failure. */
  offline?: boolean;
  /** Re-extract fetch entries even when cached. */
  refresh?: boolean;
  /** Only these ids. */
  only?: readonly string[];
  fetchImpl?: typeof fetch;
  /** Parallel loads (network politeness). */
  concurrency?: number;
};

/** Read and validate the manifest. Throws with every schema or set-level problem listed. */
export async function readManifest(dir = EVAL_DIR): Promise<EvalManifest> {
  const raw: unknown = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const parsed = evalManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`fixtures/eval/manifest.json is invalid:\n${z.prettifyError(parsed.error)}`);
  const problems = setProblems(parsed.data.entries);
  if (problems.length > 0) throw new Error(`fixtures/eval/manifest.json is invalid:\n${problems.map((p) => `✖ ${p}`).join("\n")}`);
  return parsed.data;
}

/**
 * Run the Worker's extractor on the entry's real source. PDFs are downloaded
 * first (in the product they are uploads); articles and videos go through
 * extractSource exactly as a pasted link would.
 */
export async function extractFromSource(entry: EvalManifestEntry, fetchImpl: typeof fetch = fetch): Promise<ExtractResult> {
  if (entry.kind !== "pdf") return extractSource({ kind: entry.kind, url: entry.source.url }, fetchImpl);
  const res = await fetchImpl(entry.source.url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) return { ok: false, code: "fetch_failed", message: `PDF download failed: HTTP ${res.status}`, retryable: true };
  return extractSource({ kind: "pdf", bytes: new Uint8Array(await res.arrayBuffer()) });
}

type Cached = { url: string; fetchedAt: string; title: string | null; text: string; spans: Span[] };

type Loaded = { text: string; title: string | null; spans: Span[]; origin: EvalEntry["origin"] };

async function loadText(entry: EvalManifestEntry, dir: string, opts: LoadOptions): Promise<Loaded | string> {
  if (entry.storage === "repo") {
    const path = textPath(dir, entry.id);
    if (!existsSync(path)) return `missing ${path} (run: npm run eval:snapshot -- ${entry.id})`;
    return { text: await readFile(path, "utf8"), title: null, spans: [], origin: "repo" };
  }
  const path = cachePath(dir, entry.id);
  if (!opts.refresh && existsSync(path)) {
    const cached = JSON.parse(await readFile(path, "utf8")) as Cached;
    if (cached.url === entry.source.url) return { ...cached, origin: "cache" };
  }
  if (opts.offline) return "not cached and offline";
  const result = await extractFromSource(entry, opts.fetchImpl);
  if (!result.ok) return `extract failed: ${result.code}: ${result.message}${result.detail ? ` (${result.detail})` : ""}`;
  const cached: Cached = { url: entry.source.url, fetchedAt: new Date().toISOString(), title: result.title, text: result.text, spans: result.spans };
  await mkdir(join(dir, ".cache"), { recursive: true });
  await writeFile(path, JSON.stringify(cached));
  return { ...cached, origin: "network" };
}

async function loadEntry(entry: EvalManifestEntry, dir: string, opts: LoadOptions): Promise<EvalEntry | string> {
  let loaded: Loaded | string;
  try {
    loaded = await loadText(entry, dir, opts);
  } catch (err) {
    return `load threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (typeof loaded === "string") return loaded;
  const { text, title, spans, origin } = loaded;
  if (text.trim().length === 0) return "text is empty";
  const chunks = chunkSource({ kind: entry.kind, text, title: title ?? entry.title, spans });
  if (chunks.length === 0) return "no chunks";
  return {
    ...entry,
    text,
    extractedTitle: title,
    spans,
    fingerprint: await fingerprint(text),
    chunks,
    samples: sampleChunks(text, chunks),
    origin,
  };
}

/** Load every entry (or `only`). Never throws for one bad entry: it lands in `failures`. Throws if the manifest is invalid. */
export async function loadEvalSet(opts: LoadOptions = {}): Promise<{ entries: EvalEntry[]; failures: LoadFailure[] }> {
  const dir = opts.dir ?? EVAL_DIR;
  const manifest = await readManifest(dir);
  const wanted = opts.only ? manifest.entries.filter((e) => opts.only!.includes(e.id)) : manifest.entries;
  const unknown = (opts.only ?? []).filter((id) => !manifest.entries.some((e) => e.id === id));

  const results: (EvalEntry | string)[] = new Array(wanted.length);
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const i = next++;
      results[i] = await loadEntry(wanted[i]!, dir, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));

  const entries: EvalEntry[] = [];
  const failures: LoadFailure[] = unknown.map((id) => ({ id, message: "no such entry" }));
  results.forEach((r, i) => {
    if (typeof r === "string") failures.push({ id: wanted[i]!.id, message: r });
    else entries.push(r);
  });
  return { entries, failures };
}

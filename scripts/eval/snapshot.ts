/**
 * STM-20: write the committed text of `storage: "repo"` eval entries, by
 * running the Worker's extractor on each entry's real source.
 *
 *   npm run eval:snapshot -- <id> [<id> …]    # these entries
 *   npm run eval:snapshot -- --missing        # every repo entry without a text file
 *   npm run eval:snapshot -- --all            # every repo entry (overwrites)
 *   npm run eval:snapshot -- <id> --pdf ./downloaded.pdf
 *       # a PDF entry from a copy you downloaded yourself (some hosts, e.g.
 *       # cftc.gov, refuse Node's fetch but not curl or a browser)
 *
 * Only for repo entries: the manifest schema already refuses `repo` for a
 * licence that doesn't allow redistribution. Fetch entries are never written
 * into the repo; load.ts caches them under fixtures/eval/.cache/.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { extractSource } from "../../worker/extract";
import { EVAL_DIR, extractFromSource, readManifest, textPath } from "./load";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { all: { type: "boolean", default: false }, missing: { type: "boolean", default: false }, pdf: { type: "string" } },
});

const manifest = await readManifest();
const repoEntries = manifest.entries.filter((e) => e.storage === "repo" && !e.synthetic);
const targets = values.all
  ? repoEntries
  : values.missing
    ? repoEntries.filter((e) => !existsSync(textPath(EVAL_DIR, e.id)))
    : positionals.map((id) => {
        const e = manifest.entries.find((x) => x.id === id);
        if (!e) throw new Error(`no entry ${id}`);
        if (e.storage !== "repo") throw new Error(`${id} is a fetch entry; its text is not committed`);
        return e;
      });
if (targets.length === 0) {
  console.log("nothing to snapshot (pass ids, --missing or --all)");
  process.exit(0);
}

if (values.pdf && (targets.length !== 1 || targets[0]!.kind !== "pdf")) {
  throw new Error("--pdf takes exactly one PDF entry id");
}

let failed = 0;
for (const entry of targets) {
  const result = values.pdf
    ? await extractSource({ kind: "pdf", bytes: new Uint8Array(readFileSync(values.pdf)) })
    : await extractFromSource(entry);
  if (!result.ok) {
    failed++;
    console.log(`✖ ${entry.id}: ${result.code}: ${result.message}`);
    continue;
  }
  const path = textPath(EVAL_DIR, entry.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, result.text);
  console.log(`✔ ${entry.id}: ${result.text.length} chars → ${path}`);
}
process.exit(failed > 0 ? 1 : 0);

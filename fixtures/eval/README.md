# Gate evaluation set (STM-20)

50 real sources, 25 the gate must **accept** (software engineering) and 25 it must **refuse**, each with its expected verdict. STM-21 benchmarks `Classifier` implementations on it (the gate must reach 90% accuracy before going live) and STM-22 wires the gate in.

```bash
npm run eval:check                 # load all 50, print the breakdown, exit 1 on any problem
npm run eval:check -- --offline    # no network; fails if a fetch entry isn't cached yet
npm run eval:check -- --show off-pdf-nhlbi-cookbook   # also print text and samples for one entry
npm run eval:snapshot -- <id>      # (re)write a committed text from its real source
```

In code:

```ts
import { loadEvalSet } from "../scripts/eval/load"; // path relative to your script
const { entries, failures } = await loadEvalSet();
// entries[i]: manifest fields + text, chunks (STM-17 chunkSource), samples (first/middle/last chunk), fingerprint
```

## Files

| Path | What |
|---|---|
| `manifest.json` | Every entry: label, expected `detected` phrase, provenance, licence. Validated by `scripts/eval/manifest.ts` (Zod). |
| `text/<id>.txt` | Committed text of `storage: "repo"` entries, exactly as the Worker's extractor (`extractSource`, STM-14) produced it from the real source. |
| `.cache/<id>.json` | Gitignored. Text of `storage: "fetch"` entries, extracted on first load. |

## Entry schema

| Field | Meaning |
|---|---|
| `id` | kebab slug, `se-…` for accepted, `off-…` for refused (convention only). |
| `label` | `accepted` or `refused`, the `gate_verdict` enum. |
| `detected` | Refused only: the phrase that fills "This looks like **{detected}**. CreateMyQ only covers software engineering right now." `null` when accepted. |
| `detectedSynonyms` | Refused only, optional: other phrasings that are just as right ("football" / "sports"). The verdict is what gets scored; the phrase is a softer check. |
| `topic` | Software-engineering subtopic, or the off-topic domain. For reporting spread. |
| `difficulty` | `clear`, or `borderline`: a hard negative, or a positive that looks off-topic. |
| `ambiguous` + `ambiguity` | The label is a proposal awaiting a human ruling (see below). |
| `synthetic` | Text written for the set rather than taken from a real source. None today. |
| `kind` | `pdf`, `article`, `youtube`: what the user would upload or paste. |
| `source` | `url` (what the loader fetches: the PDF itself, the page, the video), `citation`, `licence`, `licenceUrl`, `retrieved`. |
| `storage` | `repo` (text committed) or `fetch` (extracted on demand, cached outside git). |
| `rationale` | Why this label, and what makes the case interesting. |

The schema also enforces: refused ⇔ `detected`; `ambiguous` ⇔ `ambiguity`; `repo` only with a redistributable licence; article/YouTube URLs must parse as that kind with the product's own `parseSourceUrl`. The set must be exactly 25/25 with unique ids.

## What counts as software engineering here

CLAUDE.md: one subject area, software engineering; off-topic sources are refused. For labelling:

- **Accept**: material about building, running and maintaining software: architecture, distributed systems, databases (as used by engineers), testing, DevOps/CI, application security and secure development, programming languages and runtimes, data structures and algorithms in an engineering context, APIs and web protocols, version control, and engineering process that is about code (code review). A source counts by its **main subject**: a software talk full of anecdotes or physics tangents still passes.
- **Refuse**: everything else, including fields next door: pure mathematics, physics, electrical engineering and hardware, statistics or data analysis without software engineering, end-user software help (Excel), crypto trading, business and product management, and fiction (even a novel about hackers). Using computing words is not enough.
- **Undecided** (marked `ambiguous: true`, label is a proposal): see the list below.

## Licence policy

- Text is committed (`storage: "repo"`) only when the licence allows redistribution: public domain (incl. US federal government works, 17 U.S.C. §105), CC0, CC BY, CC BY-SA. Attribution is the `citation` + `licenceUrl` in the manifest; Wikipedia entries are pinned to a revision (`oldid`) so the attribution is exact. CC BY-SA text stays under CC BY-SA.
- Everything else (all rights reserved, non-commercial or no-derivatives CC, YouTube's standard licence, anything unclear) is **reference only** (`storage: "fetch"`): the loader extracts it on first use into the gitignored `.cache/`. Nothing from those sources is committed.
- Only extracted text is committed, never the original PDFs or pages.
- **Network:** a cold run fetches the 12 fetch entries (8 YouTube caption tracks, 2 copyrighted web pages, 1 CISA PDF of unclear licence, 1 CC BY-NC-SA novel), about 1 MB of text, in a few seconds. Warm or `--offline` runs need no network. If a source disappears, its entry fails loudly; replace it with a similar case.

## Adding or changing an entry

1. Pick a real source. Check its licence and decide `repo` or `fetch` by the policy above. Keep the set at 25/25 (swap rather than add) and keep the kinds and topics spread.
2. Add it to `manifest.json`. Pin Wikipedia to `&oldid=…`; for arXiv use the versioned PDF URL (`/pdf/2207.01047v1`) and check the abstract page says CC BY or CC0.
3. For a `repo` entry run `npm run eval:snapshot -- <id>`. If the host blocks Node's fetch, download the PDF yourself and run `npm run eval:snapshot -- <id> --pdf ./file.pdf` (done for `off-pdf-cftc-virtual-currency`).
4. Read the text (`npm run eval:check -- --show <id>`) to make sure it's clean and really is what the label says.
5. `npm run eval:check` and `npm test`.

## Ambiguous entries (need a ruling)

| id | Proposed | Question |
|---|---|---|
| `se-pdf-cisa-secure-by-design` | accepted | Government cybersecurity policy aimed at software makers (memory safety, secure defaults, SDLC). |
| `se-article-google-rules-of-ml` | accepted | ML engineering: production ML pipelines and monitoring, not ML theory. |
| `se-article-wiki-etl` | accepted | Data engineering: ETL pipelines. |
| `off-pdf-nist-csf` | refused | Organisational cybersecurity governance; security vocabulary but no software building. |
| `off-article-wiki-eniac` | refused | Computing history; hardware, though it covers early programming. |
| `off-article-wiki-scrum` | refused | Agile project management, born in software teams. |

A ruling that flips a label also needs a swap elsewhere to keep 25/25.

## Known quirks

- Committed text has no page spans (`spans: []`), so chunk `location` is null for repo entries. The gate doesn't use locations.
- STM-17's PDF heading detection takes some recipe lines as headings in the cookbook (e.g. "1 Granny Smith apple, rinsed"); harmless here, noted for the chunker.
- `off-article-doctorow-little-brother`: its first and last chunks are the Creative Commons notice and licence text. That is a real property of the source.

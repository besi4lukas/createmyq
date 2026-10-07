/**
 * STM-20: the gate's labelled evaluation set, as data. fixtures/eval/manifest.json
 * lists 50 real sources (25 software engineering, 25 not), each with the
 * verdict the gate (STM-21/22) must reach. See fixtures/eval/README.md for the
 * label guidelines and the licence policy.
 *
 * This file is the schema and the set-level rules only. Loading the text is
 * load.ts.
 */
import { z } from "zod";
import { gateVerdict, sourceKind } from "../../worker/db/schema";
import { parseSourceUrl } from "../../worker/extract/source-url";

/** The set must hold this many of each verdict. */
export const PER_LABEL = 25;

/**
 * Licences we record. Only the redistributable ones may have their text
 * committed (storage "repo"); the rest are fetched on demand into a gitignored
 * cache. "unknown" covers anything we could not confirm (e.g. YouTube's
 * standard licence), and is treated as not redistributable.
 */
export const LICENCES = [
  "public-domain",
  "us-government-work",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC-BY-SA-2.5",
  "CC-BY-SA-3.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-SA-3.0",
  "all-rights-reserved",
  "unknown",
] as const;
export type Licence = (typeof LICENCES)[number];

export const REDISTRIBUTABLE: ReadonlySet<Licence> = new Set<Licence>([
  "public-domain",
  "us-government-work",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC-BY-SA-2.5",
  "CC-BY-SA-3.0",
  "CC-BY-SA-4.0",
]);

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a lowercase-kebab slug");
const nonBlank = z.string().trim().min(1);

export const evalEntrySchema = z
  .strictObject({
    id: slug,
    /** What the gate must decide. Same values as `classification_decisions.gate_verdict`. */
    label: z.enum(gateVerdict.enumValues),
    /**
     * Refused only: the topic as it reads in "This looks like {detected}. CreateMyQ
     * only covers software engineering right now." Null for accepted entries.
     */
    detected: nonBlank.nullable(),
    /** Refused only: other phrasings that are just as right (scored leniently by STM-21). */
    detectedSynonyms: z.array(nonBlank).optional(),
    /** Software engineering subtopic, or the off-topic domain. For reporting spread. */
    topic: nonBlank,
    /** clear: an easy call. borderline: a hard negative or a positive that looks off-topic. */
    difficulty: z.enum(["clear", "borderline"]),
    /** True when CLAUDE.md does not settle the label: `label` is a proposal awaiting a human ruling. */
    ambiguous: z.boolean().default(false),
    ambiguity: nonBlank.optional(),
    /** Text written for this set rather than taken from a real source. */
    synthetic: z.boolean().default(false),
    kind: z.enum(sourceKind.enumValues),
    title: nonBlank,
    source: z.strictObject({
      /** What the loader fetches: the PDF itself, the article, or the video. */
      url: z.url({ protocol: /^https$/ }),
      citation: nonBlank,
      licence: z.enum(LICENCES),
      licenceUrl: z.url().optional(),
      /** When the text was taken (repo) or the entry was checked (fetch). */
      retrieved: z.iso.date(),
    }),
    /** repo: text in fixtures/eval/text/<id>.txt. fetch: extracted on demand into fixtures/eval/.cache/. */
    storage: z.enum(["repo", "fetch"]),
    rationale: nonBlank,
  })
  .superRefine((e, ctx) => {
    if (e.label === "refused" && e.detected === null) {
      ctx.addIssue({ code: "custom", path: ["detected"], message: "a refused entry needs the detected topic phrase" });
    }
    if (e.label === "accepted" && (e.detected !== null || e.detectedSynonyms)) {
      ctx.addIssue({ code: "custom", path: ["detected"], message: "an accepted entry has no detected topic" });
    }
    if (e.detected !== null && /^this looks like|[.!?]$/i.test(e.detected)) {
      ctx.addIssue({ code: "custom", path: ["detected"], message: "detected is the bare phrase that fills {detected}" });
    }
    if (e.ambiguous !== (e.ambiguity !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["ambiguity"], message: "ambiguous entries (and only those) explain the open question in `ambiguity`" });
    }
    if (e.storage === "repo" && !REDISTRIBUTABLE.has(e.source.licence)) {
      ctx.addIssue({
        code: "custom",
        path: ["storage"],
        message: `licence ${e.source.licence} does not allow committing the text; use storage "fetch"`,
      });
    }
    if (e.synthetic && e.storage !== "repo") {
      ctx.addIssue({ code: "custom", path: ["storage"], message: "synthetic text has nowhere to be fetched from" });
    }
    // The URL must be one the product would accept as this kind (PDFs are uploads, any https URL).
    if (e.kind !== "pdf") {
      const parsed = parseSourceUrl(e.source.url);
      if ("ok" in parsed) ctx.addIssue({ code: "custom", path: ["source", "url"], message: parsed.message });
      else if (parsed.kind !== e.kind) {
        ctx.addIssue({ code: "custom", path: ["source", "url"], message: `${withArticle(parsed.kind)} URL on ${withArticle(e.kind)} entry` });
      }
    }
  });

function withArticle(kind: string): string {
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

export const evalManifestSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(evalEntrySchema),
});

export type EvalManifestEntry = z.infer<typeof evalEntrySchema>;
export type EvalManifest = z.infer<typeof evalManifestSchema>;

/** Rules over the whole set: unique ids, 25/25. Empty when the set is valid. */
export function setProblems(entries: readonly EvalManifestEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) problems.push(`duplicate id ${e.id}`);
    seen.add(e.id);
  }
  for (const label of gateVerdict.enumValues) {
    const n = entries.filter((e) => e.label === label).length;
    if (n !== PER_LABEL) problems.push(`${n} ${label} entries, expected ${PER_LABEL}`);
  }
  return problems;
}

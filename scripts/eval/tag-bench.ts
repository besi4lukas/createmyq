/**
 * STM-23: benchmark the difficulty tagger (worker/classifier/tag.ts) on the
 * human-labelled seed questions (STM-6). The tagger sees only the question
 * (prompt, options, answer, explanation), never the label.
 *
 *   npm run eval:tags                      # seed/system-design.json, both halves
 *   npm run eval:tags -- --runs 3          # repeat, to see how stable the ratings are
 *
 * Split: the level descriptions were written from sd-001…sd-020 ("dev"); the
 * held-out half sd-021…sd-040 is the honest number. Each half is one call of
 * 20 questions, the way a run tags its ~25 kept questions in one call.
 *
 * Calls Haiku through AI Gateway (AI_GATEWAY_URL from wrangler.jsonc,
 * ANTHROPIC_API_KEY from .dev.vars or the shell). Billed: ~$0.007 per call.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  TAGGER_MAX_TOKENS,
  TAGGER_MODEL,
  TAGGER_RESPONSE_SCHEMA,
  tagQuestions,
  taggerCostUsd,
  type Difficulty,
} from "../../worker/classifier/tag";
import type { ModelCall } from "../../worker/workflows/generate";
import { agreement, difficultyConfusion, formatConfusion, type TagRow } from "./tag-metrics";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: "seed/system-design.json" },
    runs: { type: "string", default: "1" },
  },
});

type SeedQuestion = { external_id: string; difficulty: Difficulty; prompt: string; explanation: string; payload: { options: string[]; answer: string } };

async function anthropicKey(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const vars = await readFile(".dev.vars", "utf8").catch(() => "");
  const m = /^ANTHROPIC_API_KEY=(.+)$/m.exec(vars);
  if (!m) throw new Error("ANTHROPIC_API_KEY is not set (shell or .dev.vars)");
  return m[1]!.trim().replace(/^"|"$/g, "");
}

async function gatewayUrl(): Promise<string> {
  const m = /"AI_GATEWAY_URL":\s*"([^"]+)"/.exec(await readFile("wrangler.jsonc", "utf8"));
  if (!m) throw new Error("AI_GATEWAY_URL not found in wrangler.jsonc");
  return m[1]!;
}

function haiku(client: Anthropic): ModelCall {
  return async ({ system, user }) => {
    const message = await client.messages.create({
      model: TAGGER_MODEL,
      max_tokens: TAGGER_MAX_TOKENS,
      output_config: { format: { type: "json_schema", schema: TAGGER_RESPONSE_SCHEMA } },
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, stopReason: message.stop_reason, usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens } };
  };
}

function report(name: string, rows: TagRow[]): void {
  const a = agreement(rows);
  console.log(`\n### ${name}: ${a.exact}/${a.total} exact (${((100 * a.exact) / a.total).toFixed(0)}%), ${a.offByTwo} off by two levels, kappa ${a.kappa.toFixed(2)}\n`);
  console.log(formatConfusion(difficultyConfusion(rows)));
}

async function main() {
  const seed = JSON.parse(await readFile(values.file, "utf8")) as { questions: SeedQuestion[] };
  const questions = seed.questions;
  const halves = { dev: questions.slice(0, 20), holdout: questions.slice(20) };
  const client = new Anthropic({ apiKey: await anthropicKey(), baseURL: await gatewayUrl(), maxRetries: 2 });
  const model = haiku(client);
  let spent = 0;
  const all: Record<string, TagRow[]> = { dev: [], holdout: [] };

  for (let run = 1; run <= Number(values.runs); run++) {
    for (const [half, qs] of Object.entries(halves)) {
      const out = await tagQuestions(
        model,
        qs.map((q) => ({ prompt: q.prompt, options: q.payload.options, answer: q.payload.answer, explanation: q.explanation })),
      );
      const cost = taggerCostUsd(out.usage);
      spent += cost;
      console.log(`run ${run} ${half}: ${out.usage.inputTokens} in / ${out.usage.outputTokens} out, $${cost.toFixed(4)}`);
      const rows = qs.map((q, i) => ({ id: q.external_id, label: q.difficulty, got: out.tags[i]!.difficulty, confidence: out.tags[i]!.confidence }));
      for (const r of rows) if (r.label !== r.got) console.log(`  ${r.id}: human ${r.label}, classifier ${r.got} (${r.confidence})`);
      all[half]!.push(...rows);
    }
  }
  report("dev (sd-001…020, descriptions written from these)", all.dev!);
  report("holdout (sd-021…040)", all.holdout!);
  report("all 40", [...all.dev!, ...all.holdout!]);
  console.log(`\nspent ~$${spent.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

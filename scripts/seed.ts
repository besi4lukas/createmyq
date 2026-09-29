/**
 * Load a reviewed question file into the bank (STM-7).
 *
 *   npm run db:seed -- seed/system-design.json            # write
 *   npm run db:seed -- seed/system-design.json --dry-run  # report, write nothing
 *
 * Target database, first one set wins:
 *   SEED_DATABASE_URL       explicit override (e.g. a throwaway Neon branch)
 *   DATABASE_URL_UNPOOLED   shell, else .env.local (same as drizzle.config.ts)
 *
 * The whole file is validated before connecting. Then, in one transaction: the
 * category is upserted by slug and every question by external_id, inserted as
 * origin=seed, status=approved. A re-run updates content fields that changed
 * and never touches `status`, so a question hidden by flags or retired stays
 * hidden. Questions not in the file are left alone. --dry-run runs the same
 * transaction and rolls it back, so its counts are exact.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import type { z } from "zod";
import { categories, questions } from "../worker/db/schema";
import { seedFile, type SeedFile } from "./seed-file";

class DryRunRollback extends Error {}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function formatIssues(error: z.ZodError, raw: unknown): string[] {
  const rawQuestions =
    raw && typeof raw === "object" && Array.isArray((raw as { questions?: unknown }).questions)
      ? ((raw as { questions: unknown[] }).questions)
      : [];
  return error.issues.map((issue) => {
    const [head, index, ...rest] = issue.path;
    if (head === "questions" && typeof index === "number") {
      const q = rawQuestions[index] as { external_id?: unknown } | undefined;
      const id = typeof q?.external_id === "string" ? q.external_id : "(no external_id)";
      const field = rest.length ? rest.join(".") : "(question)";
      return `  ${id} [questions[${index}]] ${field}: ${issue.message}`;
    }
    return `  ${issue.path.join(".") || "(file)"}: ${issue.message}`;
  });
}

function loadFile(path: string): SeedFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = seedFile.safeParse(raw);
  if (!parsed.success) {
    const lines = formatIssues(parsed.error, raw);
    fail(`${path} is invalid (${lines.length} problem(s)); nothing was written:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Which database, described without credentials (Neon endpoint id or host). */
function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.split(".")[0]} / ${u.pathname.slice(1) || "(default db)"}`;
  } catch {
    return "(unparseable connection string)";
  }
}

async function seed(url: string, file: SeedFile, dryRun: boolean) {
  const client = new Client({ connectionString: url });
  await client.connect();
  const db = drizzle({ client });
  const counts = { inserted: 0, updated: 0, unchanged: 0, categoryInserted: false };

  try {
    await db.transaction(async (tx) => {
      const [category] = await tx
        .insert(categories)
        .values(file.category)
        .onConflictDoUpdate({
          target: categories.slug,
          set: { name: sql`excluded.name`, niche: sql`excluded.niche` },
        })
        .returning({ id: categories.id, inserted: sql<boolean>`xmax = 0` });
      if (!category) throw new Error("category upsert returned no row");
      counts.categoryInserted = category.inserted;

      const rows = file.questions.map((q) => ({
        externalId: q.external_id,
        categoryId: category.id,
        origin: "seed" as const,
        status: "approved" as const,
        format: q.format,
        difficulty: q.difficulty,
        topic: q.topic,
        prompt: q.prompt,
        explanation: q.explanation,
        payload: q.payload,
      }));

      // Content fields only. `status` is deliberately absent: a re-seed must
      // not un-hide a flagged (pending_review) or retired question. The WHERE
      // skips rows whose content is identical, so they return nothing and
      // count as unchanged. xmax = 0 marks a freshly inserted row.
      const changed = await tx
        .insert(questions)
        .values(rows)
        .onConflictDoUpdate({
          target: questions.externalId,
          set: {
            categoryId: sql`excluded.category_id`,
            format: sql`excluded.format`,
            difficulty: sql`excluded.difficulty`,
            topic: sql`excluded.topic`,
            prompt: sql`excluded.prompt`,
            explanation: sql`excluded.explanation`,
            payload: sql`excluded.payload`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`(
            ${questions.categoryId}, ${questions.format}, ${questions.difficulty},
            ${questions.topic}, ${questions.prompt}, ${questions.explanation}, ${questions.payload}
          ) is distinct from (
            excluded.category_id, excluded.format, excluded.difficulty,
            excluded.topic, excluded.prompt, excluded.explanation, excluded.payload
          )`,
        })
        .returning({ inserted: sql<boolean>`xmax = 0` });

      counts.inserted = changed.filter((r) => r.inserted).length;
      counts.updated = changed.length - counts.inserted;
      counts.unchanged = rows.length - changed.length;

      if (dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  } finally {
    await client.end();
  }
  return counts;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false } },
  });
  const path = positionals[0];
  if (!path || positionals.length > 1) fail("Usage: npm run db:seed -- <file.json> [--dry-run]");
  const dryRun = values["dry-run"];

  const file = loadFile(path);
  console.log(
    `${path}: valid. Category "${file.category.slug}", ${file.questions.length} question(s).`,
  );

  // Shell variables win over .env.local, as in drizzle.config.ts.
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const fromOverride = Boolean(process.env.SEED_DATABASE_URL);
  const url = process.env.SEED_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) fail("No database: set SEED_DATABASE_URL or DATABASE_URL_UNPOOLED.");
  console.log(
    `Target: ${describeTarget(url)} (from ${fromOverride ? "SEED_DATABASE_URL" : "DATABASE_URL_UNPOOLED"})` +
      (dryRun ? ". Dry run: the transaction is rolled back." : "."),
  );

  const c = await seed(url, file, dryRun);
  console.log(
    `${dryRun ? "Would have: " : ""}category ${c.categoryInserted ? "inserted" : "upserted (existing)"}; ` +
      `questions inserted ${c.inserted}, updated ${c.updated}, unchanged ${c.unchanged}.`,
  );
}

main().catch((err: unknown) => {
  console.error(`Seed failed, nothing was written: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

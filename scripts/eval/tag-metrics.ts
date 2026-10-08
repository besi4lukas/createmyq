/**
 * STM-23: scoring for the difficulty benchmark (tag-bench.ts). Pure.
 * Rows are (human label, classifier label) pairs.
 */
import { DIFFICULTIES, type Difficulty } from "../../worker/classifier/tag";

export type TagRow = { id: string; label: Difficulty; got: Difficulty; confidence: number };

/** matrix[label][got]: rows are the human's level, columns the classifier's. */
export type DifficultyConfusion = Record<Difficulty, Record<Difficulty, number>>;

export function difficultyConfusion(rows: readonly TagRow[]): DifficultyConfusion {
  const m = Object.fromEntries(DIFFICULTIES.map((l) => [l, Object.fromEntries(DIFFICULTIES.map((g) => [g, 0]))])) as DifficultyConfusion;
  for (const r of rows) m[r.label][r.got]++;
  return m;
}

export type Agreement = {
  total: number;
  /** Same level. */
  exact: number;
  /** Off by two levels (beginner ↔ advanced): the mistake a user would notice. */
  offByTwo: number;
  /** Cohen's kappa: agreement beyond what the two label distributions give by chance. */
  kappa: number;
};

export function agreement(rows: readonly TagRow[]): Agreement {
  const n = rows.length;
  const rank = (d: Difficulty) => DIFFICULTIES.indexOf(d);
  const exact = rows.filter((r) => r.label === r.got).length;
  const offByTwo = rows.filter((r) => Math.abs(rank(r.label) - rank(r.got)) === 2).length;
  const chance = DIFFICULTIES.reduce((sum, d) => sum + (rows.filter((r) => r.label === d).length / n) * (rows.filter((r) => r.got === d).length / n), 0);
  const observed = n === 0 ? 0 : exact / n;
  return { total: n, exact, offByTwo, kappa: n === 0 || chance === 1 ? 0 : (observed - chance) / (1 - chance) };
}

export function formatConfusion(m: DifficultyConfusion): string {
  const head = `| human \\ classifier | ${DIFFICULTIES.join(" | ")} |`;
  const sep = `|---|${DIFFICULTIES.map(() => "---:").join("|")}|`;
  const lines = DIFFICULTIES.map((l) => `| ${l} | ${DIFFICULTIES.map((g) => m[l][g]).join(" | ")} |`);
  return [head, sep, ...lines].join("\n");
}

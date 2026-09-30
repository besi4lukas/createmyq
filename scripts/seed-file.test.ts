import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seedFile } from "./seed-file";

const good = {
  category: { slug: "system-design", name: "System Design", niche: "software" },
  questions: [
    {
      external_id: "t-001",
      format: "multiple_choice",
      difficulty: "beginner",
      topic: "caching",
      prompt: "Which?",
      explanation: "Because.",
      payload: { options: ["a", "b", "c", "d"], answer: "b" },
    },
  ],
};
const withQuestion = (patch: Record<string, unknown>) => ({ ...good, questions: [{ ...good.questions[0], ...patch }] });
const messages = (raw: unknown) => {
  const r = seedFile.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("seed file schema", () => {
  it("accepts the committed seed file", () => {
    const raw = JSON.parse(readFileSync(new URL("../seed/system-design.json", import.meta.url), "utf8"));
    const parsed = seedFile.parse(raw);
    expect(parsed.questions).toHaveLength(40);
  });

  it("accepts a minimal valid file", () => {
    expect(messages(good)).toEqual([]);
  });

  it("rejects an answer that is not one of the options", () => {
    expect(messages(withQuestion({ payload: { options: ["a", "b", "c", "d"], answer: "e" } }))).toEqual([
      "questions.0.payload.answer: must equal the exact text of one of the options",
    ]);
  });

  it("rejects duplicate options (after trimming) and blank or missing ones", () => {
    expect(messages(withQuestion({ payload: { options: ["a", " a", "c", "d"], answer: "a" } }))).toEqual([
      "questions.0.payload.options.1: duplicate option",
    ]);
    expect(messages(withQuestion({ payload: { options: ["a", "b", "c"], answer: "a" } })).length).toBeGreaterThan(0);
    expect(messages(withQuestion({ prompt: "   " }))).toEqual(["questions.0.prompt: must not be blank"]);
  });

  it("rejects unknown keys, unknown difficulties and short answer", () => {
    expect(messages(withQuestion({ extra: 1 })).length).toBeGreaterThan(0);
    expect(messages(withQuestion({ payload: { options: ["a", "b", "c", "d"], answer: "a", x: 1 } })).length).toBeGreaterThan(0);
    expect(messages(withQuestion({ difficulty: "expert" })).length).toBeGreaterThan(0);
    expect(messages(withQuestion({ format: "short_answer", payload: {} })).length).toBeGreaterThan(0);
  });

  it("reports duplicate external_ids even when another question is invalid", () => {
    const q = good.questions[0]!;
    const file = { ...good, questions: [q, { ...q, prompt: "" }, q] };
    const out = messages(file);
    expect(out).toContain("questions.1.prompt: must not be blank");
    expect(out).toContain("questions.2.external_id: duplicate external_id (also questions[0])");
  });
});

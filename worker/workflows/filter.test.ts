import { describe, expect, it, vi } from "vitest";
import type { Chunk } from "../chunk";
import {
  MIN_QUALITY,
  NEAR_DUPLICATE,
  collapseNearDuplicates,
  cosine,
  countOutcomes,
  filterQuestions,
  gradeQuestions,
  graderCostUsd,
  graderPrompt,
  passesRubric,
  qualityScore,
  type Grade,
} from "./filter";
import { MAX_QUESTIONS, type GeneratedQuestion, type ModelCall, type ModelReply } from "./generate";

const q = (prompt: string, chunkOrdinal = 0): GeneratedQuestion => ({
  chunkOrdinal,
  prompt,
  options: ["Marks it as failed", "Restarts the whole job", "Waits forever", "Asks the user"],
  answer: "Marks it as failed",
  explanation: "The master pings workers and marks a silent one as failed.",
  topic: "Fault tolerance",
  quote: "the master marks the worker as failed",
});

const grade = (marks: Partial<Grade> = {}): Grade => ({
  grounded: 2,
  single_answer: 2,
  distractors: 2,
  understanding: 2,
  explanation: 2,
  note: "",
  ...marks,
});

/** A unit vector at `deg` degrees in the plane: cosine between two is cos(difference). */
const at = (deg: number): number[] => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];

describe("rubric", () => {
  it("scores the sum of the five marks out of 10", () => {
    expect(qualityScore(grade())).toBe(1);
    expect(qualityScore(grade({ distractors: 1, understanding: 0 }))).toBeCloseTo(0.7);
    expect(qualityScore(grade({ understanding: 0 }))).toBeCloseTo(0.8);
  });

  it(`keeps a question at ${MIN_QUALITY} and drops one below`, () => {
    expect(passesRubric(grade({ distractors: 1, understanding: 1, explanation: 1 }))).toBe(true); // 0.7
    expect(passesRubric(grade({ distractors: 0, understanding: 1, grounded: 1 }))).toBe(false); // 0.6
  });

  it("drops a wrong answer, an ambiguous question, trivia or a wrong explanation whatever the total", () => {
    expect(passesRubric(grade({ grounded: 0 }))).toBe(false);
    expect(passesRubric(grade({ single_answer: 0 }))).toBe(false);
    expect(passesRubric(grade({ understanding: 0 }))).toBe(false);
    expect(passesRubric(grade({ explanation: 0 }))).toBe(false);
    // Giveaway distractors with everything else good is a weak question, not a wrong one.
    expect(passesRubric(grade({ distractors: 0 }))).toBe(true);
  });

  it("keeps an unscored question", () => {
    expect(passesRubric(null)).toBe(true);
  });
});

describe("cosine", () => {
  it("is 1 for the same direction, 0 for orthogonal, and ignores length", () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 5])).toBeCloseTo(0);
    expect(cosine(at(0), at(60))).toBeCloseTo(0.5);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("collapseNearDuplicates", () => {
  it("collapses two near-identical questions to one, keeping the better-scored", () => {
    // 0 and 2 are near-identical (cos 5° ≈ 0.996); 1 is different (cos 60° = 0.5).
    const vectors = [at(0), at(60), at(5)];
    const { kept, dropped } = collapseNearDuplicates([0, 1, 2], [0.8, 0.9, 1], vectors);
    expect(kept.sort()).toEqual([1, 2]);
    expect(dropped).toEqual([{ index: 0, duplicateOf: 2, similarity: 0.996 }]);
  });

  it("keeps the earlier one when the scores tie or there are none", () => {
    const { kept } = collapseNearDuplicates([0, 1], [null, null], [at(0), at(1)]);
    expect(kept).toEqual([0]);
  });

  it(`uses ${NEAR_DUPLICATE} as the line`, () => {
    const angle = (cos: number) => (Math.acos(cos) * 180) / Math.PI;
    expect(collapseNearDuplicates([0, 1], [1, 1], [at(0), at(angle(NEAR_DUPLICATE + 0.001))]).kept).toEqual([0]);
    expect(collapseNearDuplicates([0, 1], [1, 1], [at(0), at(angle(NEAR_DUPLICATE - 0.001))]).kept).toEqual([0, 1]);
  });

  it("keeps a question with no vector without comparing it", () => {
    const { kept } = collapseNearDuplicates([0, 1], [1, 1], [at(0), null]);
    expect(kept).toEqual([0, 1]);
  });
});

describe("filterQuestions", () => {
  it("drops below the threshold, then near-duplicates, and keeps the rest in source order with score and vector", () => {
    const questions = [q("A", 1), q("B (bad)", 1), q("C", 2), q("A again", 3)];
    const grades = [grade({ distractors: 1 }), grade({ grounded: 0 }), grade(), grade()];
    const vectors = [at(0), null, at(90), at(3)];
    const { kept, decisions } = filterQuestions(questions, grades, vectors);
    expect(kept.map((k) => k.prompt)).toEqual(["C", "A again"]);
    expect(kept[0]).toMatchObject({ qualityScore: 1, embedding: at(90) });
    expect(decisions.map((d) => d.outcome)).toEqual(["near_duplicate", "below_threshold", "kept", "kept"]);
    expect(decisions[0]).toMatchObject({ duplicateOf: 3, score: 0.9 });
    expect(countOutcomes(decisions)).toEqual({ kept: 2, below_threshold: 1, near_duplicate: 1, capped: 0 });
  });

  it(`caps at ${MAX_QUESTIONS}, dropping the lowest-scored`, () => {
    const questions = Array.from({ length: 30 }, (_, i) => q(`Q${i}`));
    // Q0..Q4 are the weakest that still pass.
    const grades = questions.map((_, i) => (i < 5 ? grade({ distractors: 1 }) : grade()));
    const { kept, decisions } = filterQuestions(questions, grades, questions.map(() => null));
    expect(kept).toHaveLength(MAX_QUESTIONS);
    expect(kept[0]?.prompt).toBe("Q5");
    expect(decisions.slice(0, 5).every((d) => d.outcome === "capped")).toBe(true);
  });

  it("keeps everything (up to the cap) when grading and embedding both failed", () => {
    const questions = [q("A"), q("B"), q("C")];
    const { kept } = filterQuestions(questions, [null, null, null], [null, null, null]);
    expect(kept.map((k) => [k.prompt, k.qualityScore, k.embedding])).toEqual([
      ["A", null, null],
      ["B", null, null],
      ["C", null, null],
    ]);
  });
});

describe("gradeQuestions", () => {
  const TEXT = "Intro. The master pings every worker periodically and marks a silent worker as failed.";
  const CHUNKS: Chunk[] = [
    { ordinal: 0, start: 0, end: 6, headingPath: [], location: null },
    { ordinal: 1, start: 7, end: TEXT.length, headingPath: ["3 Implementation"], location: "p. 4" },
  ];
  const reply = (body: unknown, stopReason = "end_turn"): ModelReply => ({
    text: typeof body === "string" ? body : JSON.stringify(body),
    stopReason,
    usage: { inputTokens: 1000, outputTokens: 200 },
  });
  const model = (r: ModelReply) => vi.fn<ModelCall>().mockResolvedValue(r);
  const g = (id: number, marks: Partial<Grade> = {}) => ({ id, ...grade(marks) });

  it("sends each passage once with its questions, and maps grades back by id", async () => {
    const questions = [q("First?", 1), q("Second?", 1)];
    const call = model(reply({ grades: [g(2, { distractors: 0 }), g(1)] }));
    const result = await gradeQuestions(call, questions, CHUNKS, TEXT);
    const user = call.mock.calls[0]![0].user;
    expect(user).toContain('<passage section="3 Implementation">');
    expect(user).not.toContain("Intro.");
    expect(user).toContain('<question id="1">\nFirst?\nA) Marks it as failed');
    expect(user).toContain("Marked answer: A");
    expect(result.grades.map((x) => x?.distractors)).toEqual([2, 0]);
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
  });

  it("leaves a question unscored when its grade is missing or malformed", async () => {
    const questions = [q("First?", 1), q("Second?", 1), q("Third?", 1)];
    const call = model(reply({ grades: [g(1), { id: 2, grounded: 7 }, g(9)] }));
    const { grades } = await gradeQuestions(call, questions, CHUNKS, TEXT);
    expect(grades.map((x) => x !== null)).toEqual([true, false, false]);
  });

  it("throws on an unusable reply, so the step retries", async () => {
    const questions = [q("First?", 1)];
    await expect(gradeQuestions(model(reply("not json")), questions, CHUNKS, TEXT)).rejects.toThrow("not JSON");
    await expect(gradeQuestions(model(reply({ grades: [] }, "max_tokens")), questions, CHUNKS, TEXT)).rejects.toThrow("stop_reason");
    await expect(gradeQuestions(model(reply({ nope: 1 })), questions, CHUNKS, TEXT)).rejects.toThrow("wrong shape");
  });

  it("puts the passage before its questions, and skips passages with none", () => {
    const prompt = graderPrompt([q("Only?", 1)], CHUNKS, TEXT);
    expect(prompt.startsWith("Grade all 1 questions.")).toBe(true);
    expect(prompt.indexOf("<passage")).toBeLessThan(prompt.indexOf("<question"));
    expect(prompt.match(/<passage/g)).toHaveLength(1);
  });
});

describe("graderCostUsd", () => {
  it("prices Haiku 4.5 at $1 / $5 per million tokens", () => {
    expect(graderCostUsd({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1);
    expect(graderCostUsd({ inputTokens: 11_000, outputTokens: 2_000 })).toBeCloseTo(0.021);
  });
});

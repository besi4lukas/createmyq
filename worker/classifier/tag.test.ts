import { describe, expect, it } from "vitest";
import { fakeModel } from "../testing/fake-classifier-backends";
import { generateForChunk, type GeneratedQuestion } from "../workflows/generate";
import {
  TAGGER_SYSTEM_PROMPT,
  applyTags,
  clampConfidence,
  difficultyCounts,
  formatOfPayload,
  parseTags,
  tagQuestions,
  taggerCostUsd,
  taggerPrompt,
} from "./tag";

const Q = (n: number) => ({
  prompt: `Question ${n}?`,
  options: ["right", "wrong 1", "wrong 2", "wrong 3"],
  answer: "right",
  explanation: `Because ${n}.`,
});

describe("formatOfPayload", () => {
  it("is multiple_choice for a valid multiple-choice payload", () => {
    expect(formatOfPayload({ options: ["a", "b", "c", "d"], answer: "c" })).toBe("multiple_choice");
  });

  it("throws when no format's schema accepts the payload", () => {
    expect(() => formatOfPayload({ options: ["a", "b", "c"], answer: "a" })).toThrow(/no question format/);
    expect(() => formatOfPayload({ options: ["a", "b", "c", "d"], answer: "e" })).toThrow(/no question format/);
    expect(() => formatOfPayload({ expected: "x" })).toThrow(/no question format/);
  });
});

describe("parseTags", () => {
  it("returns one level and confidence per question, in id order", () => {
    const text = JSON.stringify({
      tags: [
        { id: 2, difficulty: "advanced", confidence: 0.9 },
        { id: 1, difficulty: "beginner", confidence: 0.7 },
      ],
    });
    expect(parseTags(text, 2)).toEqual([
      { difficulty: "beginner", confidence: 0.7 },
      { difficulty: "advanced", confidence: 0.9 },
    ]);
  });

  it("keeps the first rating for a repeated id and ignores out-of-range or invalid items", () => {
    const text = JSON.stringify({
      tags: [
        { id: 1, difficulty: "intermediate", confidence: 0.8 },
        { id: 1, difficulty: "advanced", confidence: 0.9 },
        { id: 3, difficulty: "beginner", confidence: 0.9 },
        { id: 0, difficulty: "beginner", confidence: 0.9 },
        { id: 1, difficulty: "expert", confidence: 0.9 },
      ],
    });
    expect(parseTags(text, 1)).toEqual([{ difficulty: "intermediate", confidence: 0.8 }]);
  });

  it("throws when a question is left out, so the step retries instead of storing an untagged question", () => {
    const text = JSON.stringify({ tags: [{ id: 1, difficulty: "beginner", confidence: 0.9 }, { id: 3, difficulty: "expert", confidence: 1 }] });
    expect(() => parseTags(text, 3)).toThrow(/left out 2 of 3/);
  });

  it("throws on a reply that is not JSON or the wrong shape", () => {
    expect(() => parseTags("beginner", 1)).toThrow(/not JSON/);
    expect(() => parseTags(JSON.stringify({ levels: [] }), 1)).toThrow(/wrong shape/);
  });
});

describe("clampConfidence", () => {
  it("clamps to 1/3–1 and rounds to 2 places", () => {
    expect(clampConfidence(0.876)).toBe(0.88);
    expect(clampConfidence(7)).toBe(1);
    expect(clampConfidence(0)).toBe(0.33);
    expect(clampConfidence(Number.NaN)).toBeCloseTo(1 / 3);
  });
});

describe("tagQuestions", () => {
  it("tags format from the payload and difficulty from one model call", async () => {
    const calls: { system: string; user: string }[] = [];
    const model = fakeModel(
      {
        json: {
          tags: [
            { id: 1, difficulty: "beginner", confidence: 0.9 },
            { id: 2, difficulty: "advanced", confidence: 0.6 },
          ],
        },
        usage: { inputTokens: 5000, outputTokens: 600 },
      },
      calls,
    );
    const out = await tagQuestions(model, [Q(1), { ...Q(2), answer: "wrong 2" }]);
    expect(out.tags).toEqual([
      { format: "multiple_choice", difficulty: "beginner", confidence: 0.9 },
      { format: "multiple_choice", difficulty: "advanced", confidence: 0.6 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toBe(TAGGER_SYSTEM_PROMPT);
    expect(calls[0]!.user).toContain('<question id="2">\nQuestion 2?\nA) right\nB) wrong 1\nC) wrong 2\nD) wrong 3\nCorrect answer: C\nExplanation: Because 2.\n</question>');
    expect(taggerCostUsd(out.usage)).toBeCloseTo(0.008);
  });

  it("makes no call for no questions", async () => {
    const calls: { system: string; user: string }[] = [];
    expect(await tagQuestions(fakeModel({ json: { tags: [] } }, calls), [])).toEqual({ tags: [], usage: { inputTokens: 0, outputTokens: 0 } });
    expect(calls).toHaveLength(0);
  });

  it("throws on a cut-off reply, and before calling the model on a payload with no format", async () => {
    await expect(tagQuestions(fakeModel({ json: { tags: [] }, stopReason: "max_tokens" }), [Q(1)])).rejects.toThrow(/max_tokens/);
    const calls: { system: string; user: string }[] = [];
    await expect(tagQuestions(fakeModel({ json: { tags: [] } }, calls), [{ ...Q(1), answer: "nope" }])).rejects.toThrow(/no question format/);
    expect(calls).toHaveLength(0);
  });
});

describe("taggerPrompt", () => {
  it("numbers questions from 1 and states the count", () => {
    const p = taggerPrompt([Q(1), Q(2), Q(3)]);
    expect(p.startsWith("Rate all 3 questions.")).toBe(true);
    expect(p).toContain('<question id="3">');
  });
});

describe("applyTags and difficultyCounts", () => {
  it("joins tags onto questions and counts levels", () => {
    const tagged = applyTags(
      [{ prompt: "a" }, { prompt: "b" }],
      [
        { format: "multiple_choice", difficulty: "advanced", confidence: 0.8 },
        { format: "multiple_choice", difficulty: "advanced", confidence: 0.7 },
      ],
    );
    expect(tagged[1]).toEqual({ prompt: "b", format: "multiple_choice", difficulty: "advanced", confidence: 0.7 });
    expect(difficultyCounts(tagged)).toEqual({ beginner: 0, intermediate: 0, advanced: 2 });
  });

  it("throws when the lists don't line up", () => {
    expect(() => applyTags([{}], [])).toThrow(/1 questions but 0 tags/);
  });
});

describe("the generator can't choose difficulty or format", () => {
  it("drops a generated question that sets either, and its output type has neither field", async () => {
    const base = { prompt: "What?", options: ["a", "b", "c", "d"], answer: "a", explanation: "Because.", topic: "T", quote: "the passage" };
    const model = fakeModel({ json: { questions: [base, { ...base, difficulty: "advanced" }, { ...base, format: "short_answer" }] } });
    const chunk = { ordinal: 0, start: 0, end: 11, headingPath: [], location: null };
    const result = await generateForChunk(model, chunk, "the passage", 5);
    expect(result.questions).toHaveLength(1);
    expect(result.rejected).toEqual({ shape: 2 });
    const q: GeneratedQuestion = result.questions[0]!;
    expect(Object.keys(q).sort()).toEqual(["answer", "chunkOrdinal", "explanation", "options", "prompt", "quote", "topic"]);
    // @ts-expect-error GeneratedQuestion has no difficulty: only the tagger assigns it.
    void q.difficulty;
    // @ts-expect-error nor a format.
    void q.format;
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Chunk } from "../chunk";
import {
  MAX_CHUNKS,
  costUsd,
  generateForChunk,
  planChunks,
  quoteIsInPassage,
  spreadAnswers,
  type GeneratedQuestion,
  type ModelCall,
  type ModelReply,
} from "./generate";

const TEXT =
  "Intro.\n\nMapReduce splits the input into M pieces.  The master pings every worker periodically.\n" +
  "If no response is received from a worker in a certain amount of time, the master marks the worker as failed.";
const CHUNK: Chunk = { ordinal: 3, start: 8, end: TEXT.length, headingPath: ["3 Implementation", "3.3 Fault Tolerance"], location: "p. 4" };

const question = (overrides: Record<string, unknown> = {}) => ({
  prompt: "What does the master do when a worker stops responding?",
  options: ["Marks it as failed", "Restarts the whole job", "Waits forever", "Asks the user"],
  answer: "Marks it as failed",
  explanation: "The master pings workers and marks a silent one as failed.",
  topic: "Fault tolerance",
  quote: "the master marks the worker as failed",
  ...overrides,
});

const reply = (body: unknown, stopReason: string | null = "end_turn"): ModelReply => ({
  text: typeof body === "string" ? body : JSON.stringify(body),
  stopReason,
  usage: { inputTokens: 1000, outputTokens: 500 },
});

/** A fake model that returns the given replies in order. */
const fakeModel = (...replies: ModelReply[]) => {
  const model = vi.fn<ModelCall>();
  for (const r of replies) model.mockResolvedValueOnce(r);
  return model;
};

describe("generateForChunk", () => {
  it("keeps every question from a valid reply, with its chunk", async () => {
    const model = fakeModel(reply({ questions: [question(), question({ prompt: "Who pings the workers?" })] }));
    const result = await generateForChunk(model, CHUNK, TEXT, 3);
    expect(model).toHaveBeenCalledTimes(1);
    expect(result.calls).toBe(1);
    expect(result.dropped).toBeNull();
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toEqual({ chunkOrdinal: 3, ...question() });
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
  });

  it("sends the passage and the heading path, not the whole text", async () => {
    const model = fakeModel(reply({ questions: [] }));
    await generateForChunk(model, CHUNK, TEXT, 3);
    const { user } = model.mock.calls[0]![0];
    expect(user).toContain("Section: 3 Implementation › 3.3 Fault Tolerance");
    expect(user).toContain("Write 3 questions");
    expect(user).toContain("<passage>\n" + TEXT.slice(8) + "\n</passage>");
    expect(user).not.toContain("Intro.");
  });

  it("retries a malformed reply once and keeps the second", async () => {
    const model = fakeModel(reply("{ not json"), reply({ questions: [question()] }));
    const result = await generateForChunk(model, CHUNK, TEXT, 3);
    expect(model).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ calls: 2, dropped: null });
    expect(result.questions).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 1000 });
  });

  it("drops the chunk after two invalid replies, and never asks a third time", async () => {
    const model = fakeModel(reply({ items: [question()] }), reply({ questions: [question()] }, "max_tokens"), reply({ questions: [question()] }));
    const result = await generateForChunk(model, CHUNK, TEXT, 3);
    expect(model).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ calls: 2, questions: [], dropped: "stop_reason max_tokens" });
    expect(result.usage.inputTokens).toBe(2000);
  });

  it("treats a refusal as an invalid reply", async () => {
    const model = fakeModel(reply("", "refusal"), reply("", "refusal"));
    expect((await generateForChunk(model, CHUNK, TEXT, 3)).dropped).toBe("stop_reason refusal");
  });

  it("drops invalid questions one by one from an otherwise valid reply", async () => {
    const model = fakeModel(
      reply({
        questions: [
          question(),
          question({ answer: "Not one of the options" }),
          question({ options: ["A", "B", "C"], answer: "A" }),
          question({ options: ["A", "A ", "B", "C"], answer: "A" }),
          question({ explanation: "   " }),
          question({ difficulty: "advanced" }),
          { prompt: "only a prompt" },
          "a string",
        ],
      }),
    );
    const result = await generateForChunk(model, CHUNK, TEXT, 10);
    expect(model).toHaveBeenCalledTimes(1);
    expect(result.questions).toHaveLength(1);
    expect(result.rejected).toEqual({ payload: 3, shape: 4 });
  });

  it("drops a question whose quote is not in the chunk", async () => {
    const model = fakeModel(
      reply({
        questions: [
          question({ quote: "workers vote to elect a new master" }),
          question({ quote: "MapReduce splits the input" }), // in this chunk
          question({ quote: "Intro." }), // in the text, outside this chunk
        ],
      }),
    );
    const result = await generateForChunk(model, CHUNK, TEXT, 3);
    expect(result.questions.map((q) => q.quote)).toEqual(["MapReduce splits the input"]);
    expect(result.rejected).toEqual({ quote_not_in_passage: 2 });
  });

  it("keeps no more questions than it asked for", async () => {
    const model = fakeModel(reply({ questions: Array.from({ length: 6 }, (_, i) => question({ prompt: `Q${i}` })) }));
    expect((await generateForChunk(model, CHUNK, TEXT, 3)).questions).toHaveLength(3);
  });

  it("lets a failed request throw, for the Workflow step to retry", async () => {
    const model = vi.fn<ModelCall>().mockRejectedValue(new Error("529 overloaded"));
    await expect(generateForChunk(model, CHUNK, TEXT, 3)).rejects.toThrow("529 overloaded");
  });
});

describe("quoteIsInPassage", () => {
  it("ignores differences in whitespace, curly quotes and dashes", () => {
    const passage = "The master “pings” every\n worker — periodically.";
    expect(quoteIsInPassage('master "pings" every worker - periodically', passage)).toBe(true);
    expect(quoteIsInPassage("master pings every worker", passage)).toBe(false);
  });
});

describe("planChunks", () => {
  const chunks = (n: number): Chunk[] =>
    Array.from({ length: n }, (_, i) => ({ ordinal: i, start: i * 10, end: i * 10 + 9, headingPath: [], location: null }));

  it("spreads the picks across a long source, skipping the first and last chunk", () => {
    const plan = planChunks(chunks(24));
    expect(plan.chunks).toHaveLength(MAX_CHUNKS);
    expect(plan.chunks.map((c) => c.ordinal)).toEqual([1, 4, 6, 9, 12, 14, 17, 20, 22]);
    expect(plan.perChunk).toBe(3);
  });

  it("asks more of each chunk of a short source, up to a limit", () => {
    expect(planChunks(chunks(4))).toMatchObject({ perChunk: 7 });
    expect(planChunks(chunks(1))).toMatchObject({ perChunk: 8 });
    expect(planChunks(chunks(0))).toEqual({ chunks: [], perChunk: 0 });
  });
});

describe("spreadAnswers", () => {
  const generated = (n: number): GeneratedQuestion[] =>
    Array.from({ length: n }, (_, i) => ({ chunkOrdinal: 0, ...question({ prompt: `Q${i}` }) }));

  it("spreads the correct option evenly over the four positions, keeping the others in order", () => {
    const final = spreadAnswers(generated(8));
    expect(final.map((q) => q.options.indexOf(q.answer))).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(final[2]?.options).toEqual(["Restarts the whole job", "Waits forever", "Marks it as failed", "Asks the user"]);
  });
});

describe("costUsd", () => {
  it("prices Sonnet 5.5 at $2 / $10 per million tokens", () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2);
    expect(costUsd({ inputTokens: 16_000, outputTokens: 7_000 })).toBeCloseTo(0.102);
  });
});

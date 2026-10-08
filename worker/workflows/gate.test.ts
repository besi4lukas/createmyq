import { describe, expect, it } from "vitest";
import type { Chunk } from "../chunk";
import { sampleChunks } from "../chunk/sample";
import { FallbackClassifier } from "../classifier/fallback";
import { CLASSIFIER_MODEL } from "../classifier/model";
import { ACTIVE_CLASSIFIER, FALLBACK_THRESHOLD } from "../classifier";
import type { Classification, Classifier, EmbeddingScores } from "../classifier/types";
import { EMBEDDING_MODEL } from "./embed";
import { UNNAMED_TOPIC, classificationInputs, classifySpend, gateDecision, gateReason, offTopicMessage } from "./gate";

const chunk = (ordinal: number): Chunk => ({
  ordinal,
  start: ordinal * 100,
  end: ordinal * 100 + 80,
  headingPath: [`Section ${ordinal}`],
  location: `p. ${ordinal + 1}`,
});
const text = "x".repeat(1000);
const samples = sampleChunks(text, [0, 1, 2, 3, 4].map(chunk));

const score = (margin: number) => ({
  accept: { id: "distributed-systems", score: 0.5 + margin },
  refuse: { id: "cooking", detected: "cooking", score: 0.5 },
  margin,
});
const embedding = (margins: number[]): EmbeddingScores => ({
  samples: margins.map(score),
  margin: margins.reduce((a, b) => a + b, 0) / margins.length,
});

const embeddingRefusal: Classification = {
  verdict: "refused",
  confidence: 1,
  detected: "cooking",
  by: "embedding",
  usage: { inputTokens: 0, outputTokens: 0, embeddedChars: 16_000 },
  costUsd: 0.00005,
  embedding: embedding([-0.2, -0.15, -0.18]),
};

function fixed(result: Classification): Classifier {
  return { classify: async () => result };
}

/** A real FallbackClassifier over fixed answers: embeddings unsure, Haiku decides. */
async function fellThrough(): Promise<Classification> {
  const unsure: Classification = { ...embeddingRefusal, verdict: "accepted", confidence: 0.6, detected: null, embedding: embedding([0.03, -0.01, 0.04]) };
  const model: Classification = {
    verdict: "refused",
    confidence: 0.95,
    detected: "cooking",
    by: "model",
    usage: { inputTokens: 4200, outputTokens: 25, embeddedChars: 0 },
    costUsd: 0.004325,
  };
  return new FallbackClassifier(fixed(unsure), fixed(model), 0.9).classify(samples.map((s) => s.text));
}

describe("offTopicMessage", () => {
  it("is the exact CLAUDE.md refusal with the detected topic", () => {
    expect(offTopicMessage("cooking")).toBe("This looks like cooking. CreateMyQ only covers software engineering right now.");
  });

  it("still reads as a sentence when no topic was named", () => {
    expect(offTopicMessage(null)).toBe(`This looks like ${UNNAMED_TOPIC}. CreateMyQ only covers software engineering right now.`);
    expect(offTopicMessage("  ")).toContain(UNNAMED_TOPIC);
  });
});

describe("classificationInputs", () => {
  it("records which chunks were read and their scores, never their text", () => {
    const inputs = classificationInputs(samples, embeddingRefusal);
    expect(inputs.samples).toEqual([
      { position: "start", ordinal: 0, charStart: 0, charEnd: 80, location: "p. 1", headingPath: ["Section 0"], scores: score(-0.2) },
      { position: "middle", ordinal: 2, charStart: 200, charEnd: 280, location: "p. 3", headingPath: ["Section 2"], scores: score(-0.15) },
      { position: "end", ordinal: 4, charStart: 400, charEnd: 480, location: "p. 5", headingPath: ["Section 4"], scores: score(-0.18) },
    ]);
    expect(inputs).toMatchObject({ version: 1, classifier: ACTIVE_CLASSIFIER, threshold: FALLBACK_THRESHOLD, primary: null });
    expect(inputs.embeddingMargin).toBeCloseTo(-0.17667, 4);
    expect(JSON.stringify(inputs)).not.toContain("xxxx");
  });

  it("keeps the fallback's first opinion and the embedding scores when the model decided", async () => {
    const inputs = classificationInputs(samples, await fellThrough());
    expect(inputs.primary).toEqual({ by: "embedding", verdict: "accepted", confidence: 0.6, detected: null });
    expect(inputs.samples.map((s) => s.scores?.margin)).toEqual([0.03, -0.01, 0.04]);
  });

  it("leaves scores out when there were no embeddings", () => {
    const { embedding: _e, ...modelOnly } = embeddingRefusal;
    void _e;
    const inputs = classificationInputs(samples, { ...modelOnly, by: "model" });
    expect(inputs.samples.every((s) => s.scores === null)).toBe(true);
    expect(inputs.embeddingMargin).toBeNull();
  });
});

describe("gateDecision", () => {
  it("refuses with the message and the columns for the bank", () => {
    const d = gateDecision(samples, embeddingRefusal);
    expect(d).toMatchObject({
      gateVerdict: "refused",
      detectedNiche: "cooking",
      confidence: 1,
      classifiedBy: "embedding",
      refusal: "This looks like cooking. CreateMyQ only covers software engineering right now.",
    });
    expect(d.reason).toBe("embedding refused as cooking at 1.00 (embedding margin -0.177)");
  });

  it("accepts without a refusal", () => {
    const d = gateDecision(samples, { ...embeddingRefusal, verdict: "accepted", detected: null, embedding: embedding([0.2, 0.2, 0.2]) });
    expect(d).toMatchObject({ gateVerdict: "accepted", detectedNiche: null, refusal: null });
  });

  it("says why the model was asked", async () => {
    expect(gateReason(await fellThrough())).toBe(
      "model refused as cooking at 0.95; embeddings were unsure (accepted at 0.60 < 0.9) (embedding margin 0.020)",
    );
  });
});

describe("classifySpend", () => {
  it("is one Workers AI row when the embeddings decided", () => {
    expect(classifySpend(embeddingRefusal)).toEqual([
      { label: "classify:0:embedding", purpose: "classify", provider: "workers-ai", model: EMBEDDING_MODEL, inputTokens: 0, outputTokens: 0, costUsd: 0.00005 },
    ]);
  });

  it("splits a fall-through into the embedding and the Haiku call", async () => {
    const rows = classifySpend(await fellThrough());
    expect(rows.map((r) => [r.label, r.provider, r.model, r.inputTokens, r.outputTokens])).toEqual([
      ["classify:0:embedding", "workers-ai", EMBEDDING_MODEL, 0, 0],
      ["classify:1:model", "anthropic", CLASSIFIER_MODEL, 4200, 25],
    ]);
    expect(rows[0]!.costUsd).toBeCloseTo(0.00005, 10);
    expect(rows[1]!.costUsd).toBeCloseTo(0.004325, 10);
  });
});

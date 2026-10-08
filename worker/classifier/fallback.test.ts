import { describe, expect, it } from "vitest";
import { FallbackClassifier } from "./fallback";
import type { Classification, Classifier } from "./types";

function fixed(result: Partial<Classification>, log: string[], name: string): Classifier {
  return {
    async classify() {
      log.push(name);
      return {
        verdict: "accepted",
        confidence: 0.9,
        detected: null,
        by: "embedding",
        usage: { inputTokens: 0, outputTokens: 0, embeddedChars: 100 },
        costUsd: 0.00001,
        ...result,
      };
    },
  };
}

const modelAnswer: Partial<Classification> = {
  verdict: "refused",
  confidence: 0.95,
  detected: "cooking",
  by: "model",
  usage: { inputTokens: 4000, outputTokens: 20, embeddedChars: 0 },
  costUsd: 0.0041,
};

describe("FallbackClassifier", () => {
  it("keeps the primary's answer when its confidence is at or above the threshold", async () => {
    const log: string[] = [];
    const c = new FallbackClassifier(fixed({ confidence: 0.8 }, log, "primary"), fixed(modelAnswer, log, "fallback"), 0.8);
    const r = await c.classify(["x"]);
    expect(log).toEqual(["primary"]);
    expect(r).toMatchObject({ by: "embedding", confidence: 0.8 });
    expect(r.primary).toBeUndefined();
  });

  it("asks the fallback just below the threshold, sums usage and cost, and keeps the primary's answer and scores", async () => {
    const log: string[] = [];
    const embedding = { samples: [], margin: 0.01 };
    const c = new FallbackClassifier(fixed({ confidence: 0.799, embedding }, log, "primary"), fixed(modelAnswer, log, "fallback"), 0.8);
    const r = await c.classify(["x"]);
    expect(log).toEqual(["primary", "fallback"]);
    expect(r).toMatchObject({ verdict: "refused", detected: "cooking", by: "model", confidence: 0.95 });
    expect(r.usage).toEqual({ inputTokens: 4000, outputTokens: 20, embeddedChars: 100 });
    expect(r.costUsd).toBeCloseTo(0.00411);
    expect(r.primary).toMatchObject({ by: "embedding", confidence: 0.799 });
    expect(r.embedding).toBe(embedding);
  });

  it("throws when the fallback fails instead of using the unsure answer", async () => {
    const failing: Classifier = {
      classify: () => Promise.reject(new Error("gateway down")),
    };
    const c = new FallbackClassifier(fixed({ confidence: 0.6 }, [], "primary"), failing, 0.8);
    await expect(c.classify(["x"])).rejects.toThrow("gateway down");
  });
});

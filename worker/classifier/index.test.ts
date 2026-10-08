import { describe, expect, it } from "vitest";
import { fakeEmbedder, fakeModel, towards } from "../testing/fake-classifier-backends";
import { EmbeddingClassifier } from "./embedding";
import { FallbackClassifier } from "./fallback";
import { ACTIVE_CLASSIFIER, CLASSIFIER_KINDS, FALLBACK_THRESHOLD, makeClassifier, type ClassifierBackends } from "./index";
import { ModelClassifier } from "./model";

const sure: ClassifierBackends = {
  embed: fakeEmbedder(() => towards({ cooking: 1 })),
  model: fakeModel({ json: { verdict: "refused", confidence: 0.99, detected: "cooking" } }),
};
const unsure: ClassifierBackends = {
  embed: fakeEmbedder(() => towards({ "software-engineering": 1, cooking: 0.99 })),
  model: fakeModel({ json: { verdict: "refused", confidence: 0.99, detected: "cooking" } }),
};

describe("the swap point", () => {
  it("names a real classifier and a threshold in 0.5–1.01", () => {
    expect(CLASSIFIER_KINDS).toContain(ACTIVE_CLASSIFIER);
    expect(FALLBACK_THRESHOLD).toBeGreaterThanOrEqual(0.5);
    expect(FALLBACK_THRESHOLD).toBeLessThanOrEqual(1.01);
  });

  it("builds the implementation each kind names", () => {
    expect(makeClassifier("embedding", sure)).toBeInstanceOf(EmbeddingClassifier);
    expect(makeClassifier("model", sure)).toBeInstanceOf(ModelClassifier);
    const f = makeClassifier("fallback", sure, 0.8);
    expect(f).toBeInstanceOf(FallbackClassifier);
    expect((f as FallbackClassifier).threshold).toBe(0.8);
    expect((makeClassifier("fallback", sure) as FallbackClassifier).threshold).toBe(FALLBACK_THRESHOLD);
  });

  it("the fallback answers from embeddings when sure and from the model when not", async () => {
    expect((await makeClassifier("fallback", sure).classify(["x"])).by).toBe("embedding");
    expect((await makeClassifier("fallback", unsure).classify(["x"])).by).toBe("model");
  });
});

describe("the Classifier contract, for every kind", () => {
  for (const kind of CLASSIFIER_KINDS) {
    for (const [name, backends] of Object.entries({ sure, unsure })) {
      it(`${kind} (${name}): a verdict, confidence in 0.5–1, detected only when refused, cost and usage`, async () => {
        const r = await makeClassifier(kind, backends).classify(["one", "two", "three"]);
        expect(["accepted", "refused"]).toContain(r.verdict);
        expect(r.confidence).toBeGreaterThanOrEqual(0.5);
        expect(r.confidence).toBeLessThanOrEqual(1);
        expect(r.detected === null).toBe(r.verdict === "accepted");
        expect(["embedding", "model"]).toContain(r.by);
        expect(r.costUsd).toBeGreaterThan(0);
        expect(r.usage.inputTokens + r.usage.embeddedChars).toBeGreaterThan(0);
      });
    }
    it(`${kind}: rejects empty samples`, async () => {
      await expect(makeClassifier(kind, sure).classify([])).rejects.toThrow();
    });
  }
});

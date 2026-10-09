import { describe, expect, it } from "vitest";
import { CACHE_HIT_DESCRIPTION, REFUSED_DESCRIPTION, processingSteps, type StepInput } from "./steps";

const own: StepInput = { id: "s", bankSourceId: "s", status: "uploaded", fingerprinted: false, gateVerdict: null };
const states = (s: StepInput) => processingSteps(s).map((st) => st.state);

describe("processingSteps: only what the row proves", () => {
  it("follows the run through the six steps", () => {
    expect(states(own)).toEqual(["running", "pending", "pending", "pending", "pending", "pending"]);
    expect(states({ ...own, status: "processing" })).toEqual(["done", "running", "pending", "pending", "pending", "pending"]);
    expect(states({ ...own, status: "processing", fingerprinted: true })).toEqual([
      "done", "done", "done", "running", "pending", "pending",
    ]);
    // Writing runs; the quality check is never shown done or running before the bank is stored.
    expect(states({ ...own, status: "processing", fingerprinted: true, gateVerdict: "accepted" })).toEqual([
      "done", "done", "done", "done", "running", "pending",
    ]);
    expect(states({ ...own, status: "ready", fingerprinted: true, gateVerdict: "accepted" })).toEqual(Array(6).fill("done"));
  });

  it("a cache hit: matched at the fingerprint, 4 to 6 skipped", () => {
    const steps = processingSteps({ ...own, bankSourceId: "bank", status: "ready", fingerprinted: true });
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "skipped", "skipped", "skipped"]);
    expect(steps[2]).toMatchObject({ description: CACHE_HIT_DESCRIPTION, meta: "match" });
  });

  it("a duplicate whose bank is still being made follows the bank", () => {
    const s = { ...own, bankSourceId: "bank", status: "processing" as const, fingerprinted: true, gateVerdict: "accepted" as const };
    expect(states(s)).toEqual(["done", "done", "done", "done", "running", "pending"]);
    expect(processingSteps(s)[2]!.meta).toBe("match");
  });

  it("refused at the subject check; failures at the step the row points to", () => {
    const refused = processingSteps({ ...own, status: "refused", fingerprinted: true, gateVerdict: "refused" });
    expect(refused.map((s) => s.state)).toEqual(["done", "done", "done", "failed", "skipped", "skipped"]);
    expect(refused[3]!.description).toBe(REFUSED_DESCRIPTION);
    expect(states({ ...own, status: "failed" })).toEqual(["done", "failed", "skipped", "skipped", "skipped", "skipped"]);
    expect(states({ ...own, status: "failed", fingerprinted: true, gateVerdict: "accepted" })).toEqual([
      "done", "done", "done", "done", "failed", "skipped",
    ]);
  });

  it("labels are the design's, in order", () => {
    expect(processingSteps(own).map((s) => s.label)).toEqual([
      "Claiming", "Reading", "Fingerprinting", "Checking the subject", "Writing questions", "Quality check",
    ]);
  });
});

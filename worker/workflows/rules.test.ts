import { describe, expect, it } from "vitest";
import { sourceStatus } from "../db/schema";
import { MAX_TEXT_CHARS, allowedFrom, fitsInStepResult, instanceIdFor, stubQuestions, type RunStatus } from "./rules";

describe("allowedFrom", () => {
  const canMove = (from: string, to: RunStatus) => (allowedFrom(to) as string[]).includes(from);

  it("starts a run from uploaded, and again from processing when the step re-runs", () => {
    expect(sourceStatus.enumValues.filter((from) => canMove(from, "processing"))).toEqual(["uploaded", "processing"]);
  });

  it("never restarts a finished source", () => {
    for (const from of ["ready", "refused", "failed", "duplicate"]) expect(canMove(from, "processing")).toBe(false);
  });

  it("fails only a source that is processing", () => {
    expect(sourceStatus.enumValues.filter((from) => canMove(from, "failed"))).toEqual(["processing"]);
  });

  it("marks a duplicate only from processing, or again when the step re-runs", () => {
    expect(sourceStatus.enumValues.filter((from) => canMove(from, "duplicate"))).toEqual(["processing", "duplicate"]);
  });
});

describe("instanceIdFor", () => {
  it("is the same for the same source, and a valid Workflow instance id", () => {
    const id = instanceIdFor("0b7c3f0e-8a6f-4c1e-9a43-5d2b1f7e9c10");
    expect(id).toBe(instanceIdFor("0b7c3f0e-8a6f-4c1e-9a43-5d2b1f7e9c10"));
    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
    expect(id.length).toBeLessThanOrEqual(100);
  });
});

describe("fitsInStepResult", () => {
  it("keeps the text under the 1 MiB step result limit even at two bytes a char", () => {
    expect(MAX_TEXT_CHARS * 2).toBeLessThan(1024 * 1024);
    expect(fitsInStepResult("x".repeat(MAX_TEXT_CHARS))).toBe(true);
    expect(fitsInStepResult("x".repeat(MAX_TEXT_CHARS + 1))).toBe(false);
  });
});

describe("stubQuestions", () => {
  it("is deterministic", () => {
    expect(stubQuestions("abcdef0123456789")).toEqual(stubQuestions("abcdef0123456789"));
    expect(stubQuestions("abcdef0123456789")).toHaveLength(20);
    expect(stubQuestions("abcdef0123456789")[0]).toEqual({ stem: "Stub question 1 for abcdef01" });
  });
});

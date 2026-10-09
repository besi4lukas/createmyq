import { describe, expect, it } from "vitest";
import type { Source } from "./sources";
import { cardPhase, cardTitle, confidencePercent, isCapped, readyBanner, rowMeta, sourceName, splitOnTopic, usageLabel } from "./upload-card";

const src = (over: Partial<Source> = {}): Source => ({
  id: "s",
  kind: "article",
  title: "martinfowler.com/articles/microservices.html",
  url: "https://martinfowler.com/articles/microservices.html",
  status: "processing",
  error: null,
  bankSourceId: "s",
  visibility: "private",
  fingerprinted: false,
  gateVerdict: null,
  detectedNiche: null,
  confidence: null,
  questionCount: 0,
  createdAt: "2026-10-09T10:00:00Z",
  ...over,
});

describe("cardPhase", () => {
  it("form without a job; processing while loading or working", () => {
    expect(cardPhase(null, undefined, false)).toBe("form");
    expect(cardPhase("s", undefined, false)).toBe("processing");
    expect(cardPhase("s", src({ status: "uploaded" }), false)).toBe("processing");
    expect(cardPhase("s", src({ status: "duplicate" }), false)).toBe("processing");
  });
  it("ready: holds on the finished steps for the pause, then setup", () => {
    expect(cardPhase("s", src({ status: "ready" }), true)).toBe("processing");
    expect(cardPhase("s", src({ status: "ready" }), false)).toBe("setup");
  });
  it("refused and failed have their own phase", () => {
    expect(cardPhase("s", src({ status: "refused" }), false)).toBe("refused");
    expect(cardPhase("s", src({ status: "failed" }), false)).toBe("failed");
  });
});

describe("copy", () => {
  it("titles by phase, and the cache hit once it is known", () => {
    expect(cardTitle("form", undefined)).toBe("Bring your own material");
    expect(cardTitle("processing", src())).toBe("Making your quiz");
    expect(cardTitle("processing", src({ bankSourceId: "b", fingerprinted: true }))).toBe("We’ve seen this one");
    expect(cardTitle("refused", src())).toBe("Couldn’t use this one");
    expect(cardTitle("failed", src())).toBe("Couldn’t use this one");
    expect(cardTitle("setup", src())).toBe("Your quiz is ready");
  });
  it("the ready banner says only what is known", () => {
    expect(readyBanner(src({ questionCount: 23 }))).toEqual({
      lead: "23 questions made.",
      body: "Every one points back to the part of the text it came from.",
    });
    expect(readyBanner(src({ bankSourceId: "b", questionCount: 21 })).lead).toBe("21 questions, ready now.");
    expect(readyBanner(src({ bankSourceId: "b", questionCount: 21 })).body).toContain("didn’t count toward your limit");
  });
  it("usage uses the server's cap", () => {
    const u = { used: 2, limit: 3, resetAt: "", message: null };
    expect(usageLabel(u)).toBe("2 of 3 sources used today");
    expect(isCapped(u)).toBe(false);
    expect(isCapped({ ...u, used: 3 })).toBe(true);
    expect(usageLabel({ ...u, used: 5 })).toBe("3 of 3 sources used today");
  });
  it("row meta, names and confidence; never a middot", () => {
    expect(rowMeta(src({ status: "ready", questionCount: 23 }))).toBe("23 questions, private");
    expect(rowMeta(src({ status: "ready", questionCount: 1, visibility: "group" }))).toBe("1 question, shared with the group");
    expect(rowMeta(src({ status: "uploaded" }))).toBe("Working on it");
    expect(rowMeta(src({ status: "refused" }))).toBe("Not about software engineering");
    expect(rowMeta(src({ status: "failed" }))).toBe("Didn’t work");
    expect(sourceName(src())).toBe("martinfowler.com/articles/microservices.html");
    expect(sourceName(src({ title: null }))).toBe("https://martinfowler.com/articles/microservices.html");
    expect(sourceName(undefined)).toBe("Your source");
    expect(confidencePercent(0.936)).toBe(94);
    expect(confidencePercent(null)).toBeNull();
    for (const s of ["ready", "uploaded", "refused", "failed"] as const) expect(rowMeta(src({ status: s }))).not.toContain("·");
  });
});

describe("splitOnTopic", () => {
  it("splits the stored message around the topic, or not at all", () => {
    const m = "This looks like cooking. CreateMyQ only covers software engineering right now.";
    expect(splitOnTopic(m, "cooking")).toEqual(["This looks like ", "cooking", ". CreateMyQ only covers software engineering right now."]);
    expect(splitOnTopic(m, null)).toBeNull();
    expect(splitOnTopic(m, "history")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { parse, pathOf } from "./router";
import {
  BAD_LINK,
  EMPTY_FILE,
  FAILED_FALLBACK,
  IS_YOUTUBE,
  NOT_PDF,
  NOT_YOUTUBE,
  NO_LINK,
  REFUSED_FALLBACK,
  TOO_BIG,
  checkLinkInput,
  checkPdfFile,
  elapsed,
  formatBytes,
  isWorking,
  shouldPollList,
  sourceView,
} from "./sources";

describe("checkLinkInput", () => {
  it.each([
    ["article", "", NO_LINK],
    ["article", "   ", NO_LINK],
    ["article", "martinfowler.com/articles/microservices.html", BAD_LINK],
    ["article", "ftp://example.com/a", BAD_LINK],
    ["article", "javascript:alert(1)", BAD_LINK],
    ["article", "https://www.youtube.com/watch?v=8aGhZQkoFbQ", IS_YOUTUBE],
    ["youtube", "https://martinfowler.com/articles/microservices.html", NOT_YOUTUBE],
    ["youtube", "https://youtu.be/8aGhZQkoFbQ", null],
    ["youtube", "https://m.youtube.com/watch?v=8aGhZQkoFbQ", null],
    ["article", "  https://martinfowler.com/articles/microservices.html  ", null],
    ["article", "http://example.com/post", null],
  ] as const)("%s %j → %j", (kind, text, expected) => {
    expect(checkLinkInput(kind, text)).toBe(expected);
  });
});

describe("checkPdfFile", () => {
  it.each([
    [{ name: "paper.pdf", size: 1000, type: "application/pdf" }, null],
    [{ name: "PAPER.PDF", size: 1000, type: "" }, null],
    [{ name: "notes.txt", size: 1000, type: "text/plain" }, NOT_PDF],
    [{ name: "paper.pdf", size: 1000, type: "image/png" }, NOT_PDF],
    [{ name: "paper.pdf", size: 0, type: "application/pdf" }, EMPTY_FILE],
    [{ name: "paper.pdf", size: 20 * 1024 * 1024, type: "application/pdf" }, null],
    [{ name: "paper.pdf", size: 20 * 1024 * 1024 + 1, type: "application/pdf" }, TOO_BIG],
  ])("%j → %j", (file, expected) => {
    expect(checkPdfFile(file)).toBe(expected);
  });
});

describe("sourceView", () => {
  const base = { id: "a", bankSourceId: "a", error: null, questionCount: 0 };
  it.each(["uploaded", "processing", "duplicate"] as const)("%s is still working", (status) => {
    expect(isWorking(status)).toBe(true);
    expect(sourceView({ ...base, status })).toEqual({ phase: "working", kicker: "Working on it", title: "Making your quiz" });
  });

  it("ready: its own bank vs someone else's (already in the pool)", () => {
    expect(sourceView({ ...base, status: "ready", questionCount: 23 })).toMatchObject({ phase: "ready", kicker: "Done", cached: false, count: 23 });
    expect(sourceView({ ...base, status: "ready", bankSourceId: "b", questionCount: 21 })).toMatchObject({
      phase: "ready",
      kicker: "Already in the pool",
      title: "We’ve seen this one.",
      cached: true,
      count: 21,
    });
    expect(isWorking("ready")).toBe(false);
  });

  it("refused shows the stored gate message as is", () => {
    const error = "This looks like cooking. CreateMyQ only covers software engineering right now.";
    expect(sourceView({ ...base, status: "refused", error })).toEqual({ phase: "refused", title: "This one’s not really our thing.", message: error });
    expect(sourceView({ ...base, status: "refused" })).toMatchObject({ message: REFUSED_FALLBACK });
  });

  it("failed shows the stored message (scanned PDF, too thin, switched off …)", () => {
    const error = "I could not read this file. Scanned PDFs are not supported yet.";
    expect(sourceView({ ...base, status: "failed", error })).toMatchObject({ phase: "failed", kicker: "Didn’t work", message: error });
    expect(sourceView({ ...base, status: "failed" })).toMatchObject({ message: FAILED_FALLBACK });
  });
});

describe("small helpers", () => {
  it("elapsed and formatBytes", () => {
    expect(elapsed("2026-10-08T12:00:00Z", Date.parse("2026-10-08T12:01:05Z"))).toBe("1:05");
    expect(elapsed("2026-10-08T12:00:00Z", Date.parse("2026-10-08T11:59:00Z"))).toBe("0:00");
    expect(formatBytes(7797)).toBe("8 KB");
    expect(formatBytes(4.2 * 1024 * 1024)).toBe("4.2 MB");
  });

  it("routes /add and /sources/<id> round-trip; anything else under /sources is home", () => {
    const id = "2e6b9c44-522b-4f27-9967-ce651901dfd8";
    expect(parse("/add")).toEqual({ name: "add" });
    expect(parse(`/sources/${id}`)).toEqual({ name: "source", id });
    expect(parse(`/sources/${id.toUpperCase()}`)).toEqual({ name: "source", id });
    expect(pathOf({ name: "source", id })).toBe(`/sources/${id}`);
    expect(parse("/sources/nope")).toEqual({ name: "home" });
  });
});

describe("shouldPollList", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  it("polls while a recent source is working, not for finished or stuck ones", () => {
    expect(shouldPollList([{ status: "processing", createdAt: at(1) }], now)).toBe(true);
    expect(shouldPollList([{ status: "uploaded", createdAt: at(1) }, { status: "ready", createdAt: at(1) }], now)).toBe(true);
    expect(shouldPollList([{ status: "ready", createdAt: at(1) }, { status: "refused", createdAt: at(1) }], now)).toBe(false);
    expect(shouldPollList([{ status: "uploaded", createdAt: at(60) }], now)).toBe(false);
    expect(shouldPollList([], now)).toBe(false);
  });
});

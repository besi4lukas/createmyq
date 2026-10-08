import { describe, expect, it } from "vitest";
import { citationFor } from "./quiz";

describe("citationFor", () => {
  const cat = { kind: "category", category: "system-design" } as const;
  const review = { kind: "review", category: null } as const;

  it("names the category and topic", () => {
    expect(citationFor(cat, "Caching")).toBe("System Design / Caching");
    expect(citationFor(cat, null)).toBe("System Design");
  });

  it("shows only the topic in a review quiz, never the quiz title", () => {
    expect(citationFor(review, "Caching")).toBe("Caching");
    expect(citationFor(review, null)).toBeNull();
  });
});

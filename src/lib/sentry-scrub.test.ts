import { describe, expect, it } from "vitest";
import { scrubEvent, scrubText } from "./sentry-scrub";

describe("SPA scrubEvent", () => {
  it("masks free text", () => {
    expect(scrubText("x a.b@c.io y")).toBe("x [email] y");
    expect(scrubText("fetch https://h.test/api/quiz?category=a#b failed")).toBe("fetch https://h.test/api/quiz?[redacted] failed");
    expect(scrubText("Bearer eyJa.eyJb.c")).toBe("Bearer [redacted]");
  });

  it("drops user, breadcrumbs, extra, request headers and query", () => {
    expect(
      scrubEvent({
        message: "hi a@b.io",
        user: { email: "a@b.io" },
        breadcrumbs: [{ message: "ui.click" }],
        extra: { a: 1 },
        request: { url: "https://h.test/setup/x?y=1", headers: { "User-Agent": "u" } },
        exception: { values: [{ value: "token eyJa.eyJb.c" }] },
      }),
    ).toEqual({
      message: "hi [email]",
      request: { url: "https://h.test/setup/x" },
      exception: { values: [{ value: "token [jwt]" }] },
    });
  });
});

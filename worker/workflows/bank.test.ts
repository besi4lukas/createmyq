import { describe, expect, it } from "vitest";
import { isContentHashConflict } from "./bank";

describe("isContentHashConflict", () => {
  const pgError = (code: string, constraint: string) => Object.assign(new Error("duplicate key"), { code, constraint });

  it("spots the content_hash unique violation, also wrapped the way Drizzle wraps it", () => {
    const pg = pgError("23505", "sources_content_hash_unique");
    expect(isContentHashConflict(pg)).toBe(true);
    expect(isContentHashConflict(new Error("Failed query: update …", { cause: pg }))).toBe(true);
  });

  it("lets every other error through", () => {
    expect(isContentHashConflict(pgError("23505", "sources_r2_key_unique"))).toBe(false);
    expect(isContentHashConflict(pgError("40001", "sources_content_hash_unique"))).toBe(false);
    expect(isContentHashConflict(new Error("connection lost"))).toBe(false);
    expect(isContentHashConflict(undefined)).toBe(false);
  });
});

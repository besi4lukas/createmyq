import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./timeout";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("withTimeout", () => {
  it("returns the work's result and clears the timer", async () => {
    await expect(withTimeout(Promise.resolve(1), 1000, () => 0)).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the fallback when the timer wins", async () => {
    const p = withTimeout(new Promise<number>(() => {}), 1000, () => "late" as const);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe("late");
  });

  it("rejects with the fallback's error, and with the work's own error", async () => {
    const p = withTimeout(new Promise(() => {}), 50, () => {
      throw new Error("timed out");
    });
    const caught = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(50);
    await expect(caught).resolves.toBe("timed out");
    await expect(withTimeout(Promise.reject(new Error("boom")), 50, () => 0)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});

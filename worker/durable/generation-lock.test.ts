/**
 * GenerationLock (STM-16) against a fake storage: one holder at a time, the
 * lease, and release only by the holder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeState } from "../testing/fake-state";
import { LEASE_MS } from "../workflows/lock-rules";
import { GenerationLock } from "./generation-lock";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

function make(state = fakeState("v1:abc")) {
  return { lock: new GenerationLock(state.ctx, {} as Env), state };
}

describe("GenerationLock", () => {
  it("gives the lock to exactly one of two concurrent claims", async () => {
    const { lock } = make();
    // Two runs reaching the lock at once. The methods are synchronous, so the
    // runtime runs them one after the other; Promise.all is the closest a test gets.
    const [a, b] = await Promise.all([Promise.resolve().then(() => lock.claim("a")), Promise.resolve().then(() => lock.claim("b"))]);
    expect([a.granted, b.granted]).toEqual([true, false]);
    expect(b).toMatchObject({ granted: false, holder: "a" });
  });

  it("persists the holder, so a fresh instance (after eviction) still refuses others", () => {
    const state = fakeState("v1:abc");
    make(state).lock.claim("a");
    expect(make(state).lock.claim("b").granted).toBe(false);
  });

  it("is idempotent for its holder (a retried step)", () => {
    const { lock } = make();
    expect(lock.claim("a").granted).toBe(true);
    expect(lock.claim("a")).toMatchObject({ granted: true, renewed: true });
  });

  it("renews only for the holder, and never re-grants a lock that was lost and released", () => {
    const { lock } = make();
    lock.claim("a");
    vi.setSystemTime(NOW + LEASE_MS - 1);
    expect(lock.renew("a")).toEqual({ renewed: true });
    vi.setSystemTime(NOW + LEASE_MS + 1);
    expect(lock.claim("b").granted).toBe(false); // the renewal pushed the lease out
    expect(lock.renew("b")).toEqual({ renewed: false });
    // a's lease runs out, b takes over, finishes and releases: a's late renewal still fails.
    vi.setSystemTime(NOW + 3 * LEASE_MS);
    expect(lock.claim("b").granted).toBe(true);
    lock.release("b");
    expect(lock.renew("a")).toEqual({ renewed: false });
  });

  it("frees on release by the holder (success or failure path), so the next run gets it", () => {
    const { lock, state } = make();
    lock.claim("a");
    expect(lock.release("a")).toEqual({ released: true });
    expect(state.data.has("lock")).toBe(false);
    expect(lock.claim("b").granted).toBe(true);
  });

  it("ignores a release by someone else, and a repeated release", () => {
    const { lock } = make();
    lock.claim("a");
    expect(lock.release("b")).toEqual({ released: false });
    expect(lock.claim("b").granted).toBe(false);
    expect(lock.release("a")).toEqual({ released: true });
    expect(lock.release("a")).toEqual({ released: false });
  });

  it("lets another run take over when the holder died and its lease ran out", () => {
    const { lock } = make();
    lock.claim("a");
    vi.setSystemTime(NOW + LEASE_MS - 1);
    expect(lock.claim("b").granted).toBe(false);
    vi.setSystemTime(NOW + LEASE_MS);
    expect(lock.claim("b")).toMatchObject({ granted: true, tookOverFrom: "a" });
    // The old holder's renewal (before its store write) now fails, so it writes nothing.
    expect(lock.renew("a")).toEqual({ renewed: false });
    // And it can't release the new holder's lock.
    expect(lock.release("a")).toEqual({ released: false });
  });
});

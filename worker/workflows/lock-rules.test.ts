import { describe, expect, it } from "vitest";
import { sourceStatus } from "../db/schema";
import { LEASE_MS, afterFingerprint, claimLock, mayReopen, releaseLock, renewLock, type LockState } from "./lock-rules";

const T0 = 1_000_000;

describe("claimLock", () => {
  it("grants a free lock with a lease", () => {
    const { next, result } = claimLock(undefined, "a", T0);
    expect(result).toEqual({ granted: true, renewed: false, tookOverFrom: null, leaseUntil: T0 + LEASE_MS });
    expect(next).toEqual({ holder: "a", claimedAt: T0, leaseUntil: T0 + LEASE_MS });
  });

  it("refuses a second holder while the lease runs, and leaves the lock as it was", () => {
    const held = claimLock(undefined, "a", T0).next;
    const { next, result } = claimLock(held, "b", T0 + LEASE_MS - 1);
    expect(result).toEqual({ granted: false, holder: "a", leaseUntil: T0 + LEASE_MS });
    expect(next).toBe(held);
  });

  it("renews for the same holder (a retried step), keeping when it was first claimed", () => {
    const held = claimLock(undefined, "a", T0).next;
    const { next, result } = claimLock(held, "a", T0 + 60_000);
    expect(result).toMatchObject({ granted: true, renewed: true, tookOverFrom: null });
    expect(next).toEqual({ holder: "a", claimedAt: T0, leaseUntil: T0 + 60_000 + LEASE_MS });
  });

  it("lets another holder take over once the lease has run out", () => {
    const held = claimLock(undefined, "a", T0).next;
    const { next, result } = claimLock(held, "b", T0 + LEASE_MS);
    expect(result).toMatchObject({ granted: true, renewed: false, tookOverFrom: "a" });
    expect(next.holder).toBe("b");
  });

  it("lets the old holder renew an expired lease nobody took over", () => {
    const held = claimLock(undefined, "a", T0).next;
    expect(claimLock(held, "a", T0 + 2 * LEASE_MS).result).toMatchObject({ granted: true, renewed: true });
  });
});

describe("renewLock", () => {
  const held: LockState = { holder: "a", claimedAt: T0, leaseUntil: T0 + LEASE_MS };

  it("extends the holder's lease, even one that ran out if nobody took over", () => {
    expect(renewLock(held, "a", T0 + 10)).toEqual({ next: { ...held, leaseUntil: T0 + 10 + LEASE_MS }, renewed: true });
    expect(renewLock(held, "a", T0 + 2 * LEASE_MS).renewed).toBe(true);
  });

  it("fails for anyone else and for a free lock (a holder that lost it never gets it back)", () => {
    expect(renewLock(held, "b", T0)).toEqual({ next: held, renewed: false });
    expect(renewLock(undefined, "a", T0)).toEqual({ next: undefined, renewed: false });
  });
});

describe("releaseLock", () => {
  const held: LockState = { holder: "a", claimedAt: T0, leaseUntil: T0 + LEASE_MS };

  it("frees the lock for its holder", () => {
    expect(releaseLock(held, "a")).toEqual({ next: undefined, released: true });
  });

  it("does nothing for anyone else, or when free (a repeated release)", () => {
    expect(releaseLock(held, "b")).toEqual({ next: held, released: false });
    expect(releaseLock(undefined, "a")).toEqual({ next: undefined, released: false });
  });
});

describe("afterFingerprint", () => {
  it("shares a finished bank and asks the lock for anything else", () => {
    expect(afterFingerprint("ready")).toBe("done");
    expect(afterFingerprint("refused")).toBe("done");
    for (const s of ["uploaded", "processing", "failed"] as const) expect(afterFingerprint(s)).toBe("claim");
  });

  it("refuses a bank that is itself a duplicate", () => {
    expect(() => afterFingerprint("duplicate")).toThrow();
  });
});

describe("mayReopen", () => {
  it("opens an unfinished bank", () => {
    expect(mayReopen("uploaded", false)).toBe(true);
    expect(mayReopen("processing", false)).toBe(true);
  });

  it("retries a failure only if it happened before this upload", () => {
    expect(mayReopen("failed", true)).toBe(true);
    expect(mayReopen("failed", false)).toBe(false);
  });

  it("never reopens a finished or duplicate source", () => {
    const reopenable = sourceStatus.enumValues.filter((s) => mayReopen(s, true));
    expect(reopenable).toEqual(["uploaded", "processing", "failed"]);
  });
});

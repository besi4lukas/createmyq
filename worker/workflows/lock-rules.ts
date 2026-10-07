/**
 * STM-16: the pure rules of the fingerprint cache and the per-content-hash
 * generation lock. No I/O; generation.ts and durable/generation-lock.ts call these.
 *
 * Two things decide who does the work for a piece of content:
 *
 * 1. Postgres, through `sources.content_hash UNIQUE`. The first source to
 *    write a fingerprint owns it; that row is "the bank" for that content
 *    (its questions hang off it). Every later source with the same text hits
 *    the constraint, becomes `duplicate` with `duplicate_of_id` → the bank, and
 *    its uploaders are added to the bank's `source_uploads`. Nothing in app
 *    code decides this; the constraint does.
 * 2. The GenerationLock Durable Object (one per fingerprint). It decides which
 *    *run* fills the bank, and only while the bank is unfinished: exactly one
 *    holder at a time, with a lease so a run that dies can't block it forever.
 *    Every write to the bank after the fingerprint step is made by the holder.
 */
import { assertNever } from "../lib/assert";
import type { SourceStatus } from "./rules";

/**
 * How long a claim lasts without being renewed. Typical generation is ~90 s;
 * this leaves room for every step's retries. The holder renews it before each
 * bank write (store, mark failed). If it expires, the next upload of the same
 * file may take over; the old holder's renewal then fails and its writes are skipped.
 */
export const LEASE_MS = 15 * 60_000;

export type LockState = { holder: string; claimedAt: number; leaseUntil: number };

export type Claim =
  | { granted: true; renewed: boolean; tookOverFrom: string | null; leaseUntil: number }
  | { granted: false; holder: string; leaseUntil: number };

/**
 * Claim (or renew) the lock for `holder` at `now`. Granted when the lock is
 * free, already held by `holder` (a retried step, or a renewal), or held by
 * someone whose lease has run out. Otherwise the current holder is reported.
 */
export function claimLock(
  current: LockState | undefined,
  holder: string,
  now: number,
  leaseMs = LEASE_MS,
): { next: LockState; result: Claim } {
  if (current && current.holder !== holder && current.leaseUntil > now) {
    return { next: current, result: { granted: false, holder: current.holder, leaseUntil: current.leaseUntil } };
  }
  const renewed = current?.holder === holder;
  const next = { holder, claimedAt: renewed ? current.claimedAt : now, leaseUntil: now + leaseMs };
  const tookOverFrom = current && !renewed ? current.holder : null;
  return { next, result: { granted: true, renewed, tookOverFrom, leaseUntil: next.leaseUntil } };
}

/**
 * Extend the lease, only for the run that holds the lock. Unlike claimLock, a
 * free lock is not granted: a run that lost the lock (its lease ran out and
 * another run took over, maybe finished and released) never gets it back
 * this way, so its late writes are skipped.
 */
export function renewLock(
  current: LockState | undefined,
  holder: string,
  now: number,
  leaseMs = LEASE_MS,
): { next: LockState | undefined; renewed: boolean } {
  if (current?.holder !== holder) return { next: current, renewed: false };
  return { next: { ...current, leaseUntil: now + leaseMs }, renewed: true };
}

/** Only the holder can release. Releasing a free lock, or someone else's, changes nothing. */
export function releaseLock(current: LockState | undefined, holder: string): { next: LockState | undefined; released: boolean } {
  if (!current || current.holder !== holder) return { next: current, released: false };
  return { next: undefined, released: true };
}

/**
 * Once the fingerprint step knows the bank (this source, or the one that owns
 * the hash), what next. A finished bank is shared as it is: `ready` is served
 * to every uploader, and `refused` is a property of the content, so a second
 * upload gets the same answer. Anything else still needs a run, so ask the lock.
 */
export function afterFingerprint(bank: SourceStatus): "claim" | "done" {
  switch (bank) {
    case "ready":
    case "refused":
      return "done";
    case "uploaded":
    case "processing":
    case "failed":
      return "claim";
    case "duplicate":
      // The owner of a hash is never a duplicate (a duplicate's content_hash is null).
      throw new Error("the bank source is itself a duplicate");
    default:
      return assertNever(bank);
  }
}

/**
 * With the lock in hand, may this run (re)open the bank and generate it?
 *
 * - uploaded / processing: yes. Its first run is this one, or it died (the
 *   lock was free or its lease ran out).
 * - failed: only if it failed before this run's source was uploaded. A
 *   re-upload after a failure retries ("Please upload the file again." must
 *   mean something); an upload that raced the failing run shares its outcome.
 * - ready / refused: no, it finished while this run was on its way.
 */
export function mayReopen(bank: SourceStatus, failedBeforeUpload: boolean): boolean {
  if (bank === "uploaded" || bank === "processing") return true;
  if (bank === "failed") return failedBeforeUpload;
  return false;
}

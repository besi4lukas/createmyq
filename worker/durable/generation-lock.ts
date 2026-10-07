/**
 * GenerationLock (STM-16): one Durable Object per content fingerprint,
 * addressed by `idFromName(fingerprint)`. It only coordinates: it says which
 * Workflow run may fill the bank for that content right now. Generation never
 * runs here, and the outcome lives in Postgres (`sources.status`), not here.
 *
 * Storage is the synchronous KV API, and every method is synchronous from
 * start to end, so two claims can never interleave: the second one sees the
 * first one's holder. The rules are pure, in workflows/lock-rules.ts.
 *
 * Key:
 *   lock   { holder, claimedAt, leaseUntil }, absent when free
 *
 * The holder is the claiming run's own sourceId. A repeated claim by the same
 * holder (a retried step) extends the lease; so does renew(), which the holder
 * calls before each write to the bank and which fails once the lock was lost.
 * A lease that ran out is taken over lazily by the next claim; no alarm is needed.
 */
import { DurableObject } from "cloudflare:workers";
import { claimLock, releaseLock, renewLock, type Claim, type LockState } from "../workflows/lock-rules";

const LOCK = "lock";

export class GenerationLock extends DurableObject<Env> {
  private get kv() {
    return this.ctx.storage.kv;
  }

  private log(fields: Record<string, unknown>) {
    // The object's name is the fingerprint: a hash, not PII.
    console.log(JSON.stringify({ fingerprint: this.ctx.id.name, ...fields }));
  }

  claim(holder: string): Claim {
    const { next, result } = claimLock(this.kv.get<LockState>(LOCK), holder, Date.now());
    if (result.granted) {
      this.kv.put(LOCK, next);
      this.log({
        event: result.renewed ? "generation_lock_reclaimed" : "generation_lock_claimed",
        holder,
        tookOverFrom: result.tookOverFrom ?? undefined,
      });
    } else {
      this.log({ event: "generation_lock_busy", holder, heldBy: result.holder });
    }
    return result;
  }

  /** The holder, before a write to the bank: true if it still holds the lock (lease extended). */
  renew(holder: string): { renewed: boolean } {
    const { next, renewed } = renewLock(this.kv.get<LockState>(LOCK), holder, Date.now());
    if (renewed) this.kv.put(LOCK, next);
    this.log({ event: renewed ? "generation_lock_renewed" : "generation_lock_lost", holder });
    return { renewed };
  }

  release(holder: string): { released: boolean } {
    const { next, released } = releaseLock(this.kv.get<LockState>(LOCK), holder);
    if (released && !next) this.kv.delete(LOCK);
    this.log({ event: released ? "generation_lock_released" : "generation_lock_release_noop", holder });
    return { released };
  }
}

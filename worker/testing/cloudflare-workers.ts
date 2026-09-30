/**
 * Test-only stand-in for the `cloudflare:workers` module (aliased in
 * vitest.config.ts). Just enough of `DurableObject` for a class that extends it
 * to be constructed in Node with a fake `ctx`. Never bundled into the Worker.
 */
export class DurableObject<E = unknown> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: E,
  ) {}
}

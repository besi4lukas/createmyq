/** Exhaustiveness check: a `switch` over a union ends with `default: return assertNever(x)`. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

/**
 * Test-only fake of the parts of `DurableObjectState` that UserSession uses:
 * the synchronous KV API (values are structured-cloned on the way in and out,
 * like the real storage), one alarm, `blockConcurrencyWhile` and `waitUntil`.
 */
export function fakeState(name: string | undefined = "user-1") {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;

  const kv = {
    get: (key: string) => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    put: (key: string, value: unknown) => void data.set(key, structuredClone(value)),
    delete: (key: string) => data.delete(key),
    list: ({ prefix = "" }: { prefix?: string } = {}) =>
      [...data.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((k) => [k, structuredClone(data.get(k))] as [string, unknown]),
  };

  const ctx = {
    id: { name, toString: () => `do:${name ?? "anonymous"}` },
    storage: {
      kv,
      getAlarm: async () => alarm,
      setAlarm: async (at: number | Date) => {
        alarm = Number(at);
      },
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    waitUntil: () => {},
  };

  return {
    ctx: ctx as unknown as DurableObjectState,
    data,
    getAlarm: () => alarm,
    setAlarm: (at: number | null) => {
      alarm = at;
    },
  };
}

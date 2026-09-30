/**
 * Race `work` against a timer. If the timer wins, the result is `onTimeout()`
 * (or its exception, if it throws). The timer is always cleared, so a settled
 * race never leaves one behind. `work` itself is not cancelled: it carries on,
 * and its eventual result is ignored.
 */
export function withTimeout<T, F>(work: Promise<T>, ms: number, onTimeout: () => F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (err) {
        reject(err);
      }
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

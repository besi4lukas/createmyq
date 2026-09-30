import { useEffect, useState } from "react";
import { friendlyError } from "./api";

export type AsyncState<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; message: string };

/**
 * Load data once on mount (and again if `load` changes identity), with a
 * user-safe message on failure. A result that arrives after unmount is
 * dropped. Pass a stable function, e.g. one of the calls in quiz.ts.
 */
export function useAsync<T>(load: () => Promise<T>): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => !cancelled && setState({ status: "ok", data }))
      .catch((err: unknown) => !cancelled && setState({ status: "error", message: friendlyError(err) }));
    return () => {
      cancelled = true;
    };
  }, [load]);
  return state;
}

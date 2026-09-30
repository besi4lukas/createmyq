import { useEffect, useState } from "react";
import { friendlyError } from "../lib/api";
import { getActiveQuiz, type Quiz } from "../lib/quiz";
import { navigate } from "../lib/router";

export type ActiveQuiz =
  | { status: "loading" }
  | { status: "ready"; quiz: Quiz }
  | { status: "error"; message: string }
  | { status: "gone"; message: string };

/**
 * The quiz to show on /quiz: the one just started (handed over in memory), or
 * the quiz in progress from the server. With none in progress, go home.
 * `reload` fetches it again from scratch (retry, or catching up with the
 * server); `gone` ends it with a message (finished elsewhere).
 */
export function useActiveQuiz(started: Quiz | null) {
  const [state, setState] = useState<ActiveQuiz>(started ? { status: "ready", quiz: started } : { status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (started && attempt === 0) return;
    let cancelled = false;
    getActiveQuiz()
      .then((quiz) => {
        if (cancelled) return;
        if (quiz) setState({ status: "ready", quiz });
        else navigate({ name: "home" }, { replace: true });
      })
      .catch((err: unknown) => !cancelled && setState({ status: "error", message: friendlyError(err) }));
    return () => {
      cancelled = true;
    };
  }, [started, attempt]);

  function reload() {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }

  const gone = (message: string) => setState({ status: "gone", message });

  return { state, reload, gone };
}

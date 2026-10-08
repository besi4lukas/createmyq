import { useCallback, useState } from "react";
import { friendlyError } from "./api";
import { getReviewCount, startQuiz, type Quiz } from "./quiz";
import { useAsync } from "./useAsync";

/**
 * STM-25: how many misses are waiting, and a way to start a review quiz from
 * them. Used by Home and Results. `start` hands the quiz to `onStarted`, which
 * also covers "a quiz was already in progress" (resumed).
 */
export function useReview(onStarted: (quiz: Quiz, resumed: boolean) => void) {
  const count = useAsync(getReviewCount);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const { quiz, resumed } = await startQuiz({ kind: "review" });
      onStarted(quiz, resumed);
    } catch (err) {
      setError(friendlyError(err));
      setStarting(false);
    }
  }, [onStarted]);

  return { count, start, starting, error };
}

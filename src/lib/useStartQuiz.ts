import { useState } from "react";
import { friendlyError } from "./api";
import { startQuiz, type Quiz } from "./quiz";
import type { SetupValues } from "./setup";

/** What a setup form starts a quiz on: a built-in category, or one of the user's sources. */
export type StartTarget = { category: string } | { sourceId: string };

/**
 * Start a quiz from setup values (the Setup page and Home's inline setups).
 * The same POST /api/session either way; formats are not sent (every quiz is
 * multiple choice today). A quiz already in progress comes back as `resumed`,
 * which `onStarted` handles.
 */
export function useStartQuiz(target: StartTarget, onStarted: (quiz: Quiz, resumed: boolean) => void) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start({ difficulty, length, mode }: SetupValues) {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const { quiz, resumed } = await startQuiz(
        "sourceId" in target
          ? { kind: "source", sourceId: target.sourceId, difficulty, length, mode }
          : { category: target.category, difficulty, length, mode },
      );
      onStarted(quiz, resumed);
    } catch (err) {
      setError(friendlyError(err));
      setStarting(false);
    }
  }

  return { start, starting, error };
}

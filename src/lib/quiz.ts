/**
 * The quiz API as the browser sees it (STM-9 routes in worker/quiz/session-routes.ts).
 * The shapes mirror worker/durable/user-session.ts by hand: src/ never imports from worker/.
 */
import { ApiError, api } from "./api";

/** The choices, in display order. Types derive from these (one list each). */
export const DIFFICULTIES = ["beginner", "intermediate", "advanced"] as const;
export const QUIZ_LENGTHS = [5, 10, 20] as const;
export const MODES = ["practice", "exam"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];
export type Mode = (typeof MODES)[number];
export type QuizLength = (typeof QUIZ_LENGTHS)[number];

export type Question = {
  index: number;
  id: string;
  format: "multiple_choice";
  difficulty: Difficulty;
  topic: string | null;
  prompt: string;
  options: string[];
};

/** A given answer. Practice adds the verdict and explanation; Exam gets the choice only. */
export type Answer = {
  index: number;
  option: number;
  choice: string;
  correct?: boolean;
  correctAnswer?: string;
  explanation?: string;
};

/** "review" = built from the user's misses (STM-25): mixed categories and difficulties, so both are null. */
export type QuizKind = "category" | "review";

export type Quiz = {
  quizId: string;
  kind: QuizKind;
  category: string | null;
  difficulty: Difficulty | null;
  mode: Mode;
  /** What the user asked for. `questionCount` is smaller when the pool ran short. */
  length: number;
  questionCount: number;
  startedAt: string;
  /** The first unanswered question. Equals questionCount once every question is answered. */
  currentIndex: number;
  questions: Question[];
  answers: Answer[];
};

export type ReviewItem = Question & {
  option: number | null;
  choice: string | null;
  correct: boolean;
  correctAnswer: string;
  explanation: string;
};

export type QuizResult = {
  quizId: string;
  kind: QuizKind;
  category: string | null;
  difficulty: Difficulty | null;
  mode: Mode;
  score: number;
  questionCount: number;
  answered: number;
  review: ReviewItem[];
};

export type Prefs = {
  defaultDifficulty: Difficulty;
  defaultMode: Mode;
  defaultLength: QuizLength;
};

export type AnswerOutcome = {
  duplicate: boolean;
  answer: Answer;
  currentIndex: number;
  done: boolean;
};

/** Built-in categories. One today; the slug is the categories.slug in Postgres. */
export const CATEGORIES = [
  {
    slug: "system-design",
    name: "System Design",
    blurb: "Caching, partitioning, queues, consistency and the tradeoffs between them.",
  },
] as const;

export function categoryName(slug: string): string {
  return CATEGORIES.find((c) => c.slug === slug)?.name ?? slug;
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

export const MODE_LABEL: Record<Mode, string> = { practice: "Practice", exam: "Exam" };

/** What a quiz is called on screen: its category, or "Review" for a review quiz. */
export function quizTitle(q: Pick<Quiz, "kind" | "category">): string {
  return q.kind === "review" || q.category === null ? "Review what I missed" : categoryName(q.category);
}

/** "Beginner", or "Mixed levels" for a review quiz. */
export function difficultyLabel(d: Difficulty | null): string {
  return d === null ? "Mixed levels" : DIFFICULTY_LABEL[d];
}

/** How many questions are waiting for review (STM-25). */
export const getReviewCount = () => api<{ count: number }>("/review").then((r) => r.count);

export const getActiveQuiz = () => api<{ quiz: Quiz | null }>("/session").then((r) => r.quiz);

export const getPrefs = () => api<{ prefs: Prefs }>("/prefs").then((r) => r.prefs);

/**
 * Start a quiz. If one is already in progress the server keeps it and sends it
 * back with 409 `quiz_in_progress`; that quiz is returned with `resumed: true`.
 */
export type StartInput =
  | { category: string; difficulty: Difficulty; length: QuizLength; mode: Mode }
  /** A review quiz from the user's misses; length and mode come from their preferences. 404 `no_misses` if none. */
  | { kind: "review" };

export async function startQuiz(input: StartInput): Promise<{ quiz: Quiz; resumed: boolean }> {
  try {
    const { quiz } = await api<{ quiz: Quiz }>("/session", { body: input });
    return { quiz, resumed: false };
  } catch (err) {
    if (err instanceof ApiError && err.code === "quiz_in_progress") {
      const quiz = (err.data as { quiz?: Quiz } | undefined)?.quiz;
      if (quiz) return { quiz, resumed: true };
    }
    throw err;
  }
}

export const submitAnswer = (quizId: string, index: number, option: number) =>
  api<AnswerOutcome>("/session/answer", { body: { quizId, index, option } });

export const finishQuiz = (quizId: string) =>
  api<{ alreadyFinished: boolean; result: QuizResult }>("/session/finish", { body: { quizId } }).then(
    (r) => r.result,
  );

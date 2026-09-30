import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChatCircleText, SlidersHorizontal, Timer } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading } from "../components/Bits";
import { Segmented } from "../components/Segmented";
import { navigate } from "../lib/router";
import {
  CATEGORIES,
  DIFFICULTY_LABEL,
  MODE_LABEL,
  friendlyError,
  getPrefs,
  startQuiz,
  type Difficulty,
  type Mode,
  type Prefs,
  type Quiz,
  type QuizLength,
} from "../lib/quiz";

const MODE_HELP: Record<Mode, string> = {
  practice: "See the answer and why after every question.",
  exam: "No hints along the way. Everything is revealed at the end.",
};

const iconClass = "size-4";

export function SetupScreen({
  category,
  onStarted,
}: {
  category: string;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const cat = CATEGORIES.find((c) => c.slug === category);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPrefs()
      .then((p) => !cancelled && setPrefs(p))
      .catch((err: unknown) => !cancelled && setLoadError(friendlyError(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!cat) {
    return (
      <Column>
        <BackButton />
        <ErrorNotice>That category does not exist.</ErrorNotice>
      </Column>
    );
  }

  return (
    <Column>
      <BackButton />
      <div>
        <div className="kicker mb-1.5">Built-in</div>
        <h1 className="text-h2-phone sm:text-h2">{cat.name}</h1>
        <p className="mt-1.5 flex items-center gap-1.5 text-small text-muted">
          <SlidersHorizontal aria-hidden="true" className="shrink-0" />
          Filled in from your preferences. Change anything for this quiz.
        </p>
      </div>
      {loadError && (
        <ErrorNotice
          action={
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Try again
            </Button>
          }
        >
          {loadError}
        </ErrorNotice>
      )}
      {!prefs && !loadError && <Loading />}
      {prefs && <SetupForm category={cat.slug} prefs={prefs} onStarted={onStarted} />}
    </Column>
  );
}

function SetupForm({
  category,
  prefs,
  onStarted,
}: {
  category: string;
  prefs: Prefs;
  onStarted: (quiz: Quiz, resumed: boolean) => void;
}) {
  const [difficulty, setDifficulty] = useState<Difficulty>(prefs.defaultDifficulty);
  const [length, setLength] = useState<QuizLength>(prefs.defaultLength);
  const [mode, setMode] = useState<Mode>(prefs.defaultMode);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const { quiz, resumed } = await startQuiz({ category, difficulty, length, mode });
      onStarted(quiz, resumed);
    } catch (err) {
      setError(friendlyError(err));
      setStarting(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!starting) void start();
      }}
    >
      <Segmented
        label="Difficulty"
        value={difficulty}
        onChange={setDifficulty}
        options={(["beginner", "intermediate", "advanced"] as const).map((d) => ({
          value: d,
          label: DIFFICULTY_LABEL[d],
        }))}
      />
      <Segmented
        label="Length"
        value={length}
        onChange={setLength}
        options={([5, 10, 20] as const).map((n) => ({ value: n, label: String(n) }))}
      />
      <Segmented
        label="Feedback"
        value={mode}
        onChange={setMode}
        help={MODE_HELP[mode]}
        options={[
          { value: "practice", label: MODE_LABEL.practice, icon: <ChatCircleText aria-hidden="true" className={iconClass} /> },
          { value: "exam", label: MODE_LABEL.exam, icon: <Timer aria-hidden="true" className={iconClass} /> },
        ]}
      />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div>
        <Button type="submit" size="lg" disabled={starting} aria-busy={starting}>
          {starting ? "Starting…" : "Start quiz"}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </form>
  );
}

function Column({ children }: { children: ReactNode }) {
  return <div className="flex max-w-[560px] flex-col gap-6 pt-3">{children}</div>;
}

function BackButton() {
  return (
    <Button
      variant="ghost"
      className="self-start px-1.5"
      onClick={() => navigate({ name: "home" })}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Back
    </Button>
  );
}

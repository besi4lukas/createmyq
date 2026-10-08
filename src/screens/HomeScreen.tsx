import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowCounterClockwise,
  ArrowRight,
  CaretDown,
  PlayPause,
  SlidersHorizontal,
  FilePdf,
  LinkSimple,
  YoutubeLogo,
} from "@phosphor-icons/react";
import { useUser } from "@clerk/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading } from "../components/Bits";
import { QuizSetupFields } from "../components/QuizSetupFields";
import { panelEnter } from "../lib/motion";
import { linkTo, navigate } from "../lib/router";
import { CATEGORIES, difficultyLabel, getActiveQuiz, getPrefs, quizTitle, type Prefs, type Quiz } from "../lib/quiz";
import { INLINE_DEFAULT_LENGTH, closeCard, openCard, setupFromPrefs, type OpenCard } from "../lib/setup";
import { useAsync, type AsyncState } from "../lib/useAsync";
import { useStartQuiz } from "../lib/useStartQuiz";
import { useReview } from "../lib/useReview";

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
}

export function HomeScreen({ onStarted }: { onStarted: (quiz: Quiz, resumed: boolean) => void }) {
  const { user } = useUser();
  const active = useAsync(getActiveQuiz);

  const name = user?.firstName?.trim();

  return (
    <div className="flex max-w-[1000px] flex-col gap-7">
      <div className="pt-3">
        <h1 className="text-h2-phone sm:text-h2">
          {greeting()}
          {name ? `, ${name}` : ""}. What are we learning?
        </h1>
        <p className="mt-1.5 text-muted">Take a built-in quiz or turn your own reading into one.</p>
      </div>

      {active.status === "ok" && active.data && <ResumeCard quiz={active.data} />}
      {active.status === "error" && (
        <ErrorNotice>
          We could not check for a quiz in progress. {active.message}
        </ErrorNotice>
      )}

      {active.status === "ok" && !active.data && <ReviewCard onStarted={onStarted} />}

      <BuiltIn onStarted={onStarted} />

      <OwnMaterial />
    </div>
  );
}

type Category = (typeof CATEGORIES)[number];
type OnStarted = (quiz: Quiz, resumed: boolean) => void;

/**
 * The built-in category cards. "Start a quiz" opens the setup inside the card
 * (INLINE_QUIZ_SETUP_UPDATE): one card open at a time, prefilled from the
 * user's preferences each time it opens, and "Start quiz" goes straight to
 * question 1. Leaving Home unmounts this, so an open card closes.
 */
function BuiltIn({ onStarted }: { onStarted: OnStarted }) {
  const prefs = useAsync(getPrefs);
  const [open, setOpen] = useState<OpenCard>(null);
  return (
    <section aria-labelledby="builtin" className="flex max-w-[486px] flex-col gap-3">
      <h2 id="builtin" className="section-label">
        Built-in
      </h2>
      {CATEGORIES.map((c) => (
        <CategoryCard
          key={c.slug}
          category={c}
          open={open === c.slug}
          prefs={prefs}
          onOpen={() => setOpen((o) => openCard(o, c.slug))}
          onClose={() => setOpen((o) => closeCard(o, c.slug))}
          onStarted={onStarted}
        />
      ))}
    </section>
  );
}

function CategoryCard({
  category,
  open,
  prefs,
  onOpen,
  onClose,
  onStarted,
}: {
  category: Category;
  open: boolean;
  prefs: AsyncState<Prefs>;
  onOpen: () => void;
  onClose: () => void;
  onStarted: OnStarted;
}) {
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Cancel and Escape hand focus back to "Start a quiz"; another card opening does not.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    toggleRef.current?.focus();
  }, [open]);

  function cancel() {
    returnFocus.current = true;
    onClose();
  }

  return (
    <div
      className={`flex flex-col gap-2 rounded-md bg-surface p-4.5 transition-shadow duration-250 ${open ? "shadow-md" : ""}`}
    >
      <div className="kicker">Multiple choice, three levels</div>
      <h3 className="text-title leading-tight">{category.name}</h3>
      <p className="text-small opacity-80">{category.blurb}</p>
      {open ? (
        <SetupPanel id={panelId} category={category.slug} prefs={prefs} onCancel={cancel} onStarted={onStarted} />
      ) : (
        <div className="mt-1.5">
          <Button ref={toggleRef} aria-expanded={false} aria-controls={panelId} onClick={onOpen}>
            Start a quiz
            <CaretDown aria-hidden="true" className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** The setup inside an open card. Escape anywhere in it works like Cancel. */
function SetupPanel({
  id,
  category,
  prefs,
  onCancel,
  onStarted,
}: {
  id: string;
  category: string;
  prefs: AsyncState<Prefs>;
  onCancel: () => void;
  onStarted: OnStarted;
}) {
  const reduce = useReducedMotion();
  const cancelButton = (
    <Button variant="ghost" className="px-2.5" aria-expanded={true} aria-controls={id} onClick={onCancel}>
      Cancel
    </Button>
  );
  return (
    <motion.div
      id={id}
      initial={reduce ? false : panelEnter.initial}
      animate={panelEnter.animate}
      transition={panelEnter.transition}
      className="rule-fade-top mt-2 flex flex-col gap-4 pt-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="flex items-center gap-1.5 text-meta text-muted">
        <SlidersHorizontal aria-hidden="true" className="shrink-0" />
        Filled in from your preferences.
      </p>
      {prefs.status === "ok" ? (
        <InlineSetupForm category={category} prefs={prefs.data} cancelButton={cancelButton} onStarted={onStarted} />
      ) : (
        <>
          {prefs.status === "loading" ? <Loading /> : <ErrorNotice>{prefs.message}</ErrorNotice>}
          <div>{cancelButton}</div>
        </>
      )}
    </motion.div>
  );
}

function InlineSetupForm({
  category,
  prefs,
  cancelButton,
  onStarted,
}: {
  category: string;
  prefs: Prefs;
  cancelButton: ReactNode;
  onStarted: OnStarted;
}) {
  // Mounted on each open, so each open starts from the preferences again.
  const [values, setValues] = useState(() => setupFromPrefs(prefs, INLINE_DEFAULT_LENGTH));
  const { start, starting, error } = useStartQuiz(category, onStarted);
  const form = useRef<HTMLFormElement>(null);

  // Opened: focus the chosen Difficulty option (Tab and arrow keys go on from there).
  useEffect(() => {
    form.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);

  return (
    <form
      ref={form}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void start(values);
      }}
    >
      <QuizSetupFields values={values} onChange={setValues} showFormats />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="submit" size="lg" disabled={starting} aria-busy={starting}>
          {starting ? "Starting…" : "Start quiz"}
          <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
        {cancelButton}
      </div>
    </form>
  );
}

/**
 * "Your own material" (design v2, Home): the dashed tile that opens the
 * add-source screen for a PDF, an article link or a YouTube link. The list of
 * the user's sources under it is not built yet (no list route; TASKS.md).
 */
function OwnMaterial() {
  return (
    <section aria-labelledby="your-own" className="flex max-w-[486px] flex-col gap-3">
      <h2 id="your-own" className="section-label">
        Your own material
      </h2>
      <a
        {...linkTo({ name: "add" })}
        className="flex flex-col items-start gap-2.5 rounded-md border border-dashed border-accent/55 bg-accent/5 p-4.5 text-text no-underline transition-colors hover:bg-accent/11"
      >
        <span aria-hidden="true" className="flex gap-2 text-accent">
          <FilePdf className="size-5.5" />
          <LinkSimple className="size-5.5" />
          <YoutubeLogo className="size-5.5" />
        </span>
        <span className="text-title font-medium">Make a quiz from something you’re reading</span>
        <span className="text-small text-muted">
          A PDF, an article link or a YouTube video with captions. Takes about two minutes.
        </span>
      </a>
    </section>
  );
}

function ResumeCard({ quiz }: { quiz: Quiz }) {
  const answered = Math.min(quiz.currentIndex, quiz.questionCount);
  return (
    <div className="flex flex-wrap items-center gap-3.5 rounded-md bg-surface px-4 py-3.5 shadow-sm">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-panel bg-accent-900 text-accent-300"
      >
        <PlayPause className="size-5" />
      </span>
      <div className="min-w-40 flex-1">
        <div className="text-ui">Pick up where you left off</div>
        <div className="text-meta text-muted">
          {quizTitle(quiz)}, {difficultyLabel(quiz.difficulty)}, {answered} of {quiz.questionCount}{" "}
          answered
        </div>
      </div>
      <Button onClick={() => navigate({ name: "quiz" })}>Resume</Button>
    </div>
  );
}

/**
 * STM-25: "N to review" when the user has unresolved misses. Not shown when
 * there are none (or the count failed to load: Home works without it), nor
 * while a quiz is in progress (the resume card is the way forward then).
 */
function ReviewCard({ onStarted }: { onStarted: (quiz: Quiz, resumed: boolean) => void }) {
  const { count, start, starting, error } = useReview(onStarted);
  if (count.status !== "ok" || count.data === 0) return null;
  const n = count.data;
  // As wide as the category cards below it.
  return (
    <div className="flex max-w-[486px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3.5 rounded-md bg-surface px-4 py-3.5 shadow-sm">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-panel bg-accent-900 text-accent-300"
        >
          <ArrowCounterClockwise className="size-5" />
        </span>
        <div className="min-w-40 flex-1">
          <div className="text-ui">
            {n} to review
          </div>
          <div className="text-meta text-muted">
            {n === 1 ? "A question you missed" : "Questions you missed"}. Get each right twice in a row to clear it.
          </div>
        </div>
        <Button disabled={starting} aria-busy={starting} onClick={() => void start()}>
          Review
        </Button>
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </div>
  );
}

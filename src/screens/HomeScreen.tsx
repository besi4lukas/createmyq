import { useEffect, useId, useRef, useState } from "react";
import { ArrowCounterClockwise, CaretDown, PlayPause } from "@phosphor-icons/react";
import { useUser } from "@clerk/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/Button";
import { ErrorNotice } from "../components/Bits";
import { InlineSetup } from "../home/InlineSetup";
import { SourceRows } from "../home/SourceRows";
import { UploadCard, type Job } from "../home/UploadCard";
import { panelEnter } from "../lib/motion";
import { UPLOAD_PANEL, catPanel, closePanel, openPanel, srcPanel, type OpenPanel, type PanelId } from "../lib/panel";
import { navigate } from "../lib/router";
import { CATEGORIES, difficultyLabel, getActiveQuiz, getPrefs, quizTitle, type Prefs, type Quiz } from "../lib/quiz";
import { useSourceList } from "../lib/sources";
import { useAsync, type AsyncState } from "../lib/useAsync";
import { useReview } from "../lib/useReview";

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
}

export function HomeScreen({ onStarted }: { onStarted: (quiz: Quiz, resumed: boolean) => void }) {
  const { user } = useUser();
  const active = useAsync(getActiveQuiz);
  const prefs = useAsync(getPrefs);
  // Home's one open panel across category cards, the upload card and source
  // rows (src/lib/panel.ts). Home's own state, so leaving Home closes it.
  const [panel, setPanel] = useState<OpenPanel>(null);
  const panels: Panels = {
    isOpen: (id) => panel === id,
    open: (id) => setPanel((p) => openPanel(p, id)),
    close: (id) => setPanel((p) => closePanel(p, id)),
  };

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

      {/* Two equal columns (design v2 Home: grid-cols-2, gap 28). Stacked below
          lg, where a column would be too narrow for the open setup panel. */}
      <div className="grid grid-cols-1 gap-7 lg:grid-cols-2">
        <BuiltIn panels={panels} prefs={prefs} onStarted={onStarted} />
        <OwnMaterial panels={panels} prefs={prefs} onStarted={onStarted} />
      </div>

      {/* Full width under the columns, like the prototype's misses row. */}
      {active.status === "ok" && !active.data && <ReviewCard onStarted={onStarted} />}
    </div>
  );
}

type Category = (typeof CATEGORIES)[number];
type OnStarted = (quiz: Quiz, resumed: boolean) => void;
type Panels = { isOpen: (id: PanelId) => boolean; open: (id: PanelId) => void; close: (id: PanelId) => void };

/**
 * The built-in category cards. "Start a quiz" opens the setup inside the card
 * (INLINE_QUIZ_SETUP_UPDATE): one card open at a time, prefilled from the
 * user's preferences each time it opens, and "Start quiz" goes straight to
 * question 1. The open card is Home's one open panel, shared with the upload
 * card and the source rows.
 */
function BuiltIn({ panels, prefs, onStarted }: { panels: Panels; prefs: AsyncState<Prefs>; onStarted: OnStarted }) {
  return (
    <section aria-labelledby="builtin" className="flex min-w-0 flex-col gap-3">
      <h2 id="builtin" className="section-label">
        Built-in
      </h2>
      {CATEGORIES.map((c) => (
        <CategoryCard
          key={c.slug}
          category={c}
          open={panels.isOpen(catPanel(c.slug))}
          prefs={prefs}
          onOpen={() => panels.open(catPanel(c.slug))}
          onClose={() => panels.close(catPanel(c.slug))}
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
      <InlineSetup
        target={{ category }}
        prefs={prefs}
        onStarted={onStarted}
        secondary={
          <Button variant="ghost" className="px-2.5" aria-expanded={true} aria-controls={id} onClick={onCancel}>
            Cancel
          </Button>
        }
      />
    </motion.div>
  );
}

/**
 * "Your own material" (INLINE_UPLOAD_AND_SOURCES_UPDATE): the upload tile that
 * opens into a card, and the user's saved sources under it. The job the card
 * is following lives here, so closing the card mid-run keeps it.
 */
function OwnMaterial({ panels, prefs, onStarted }: { panels: Panels; prefs: AsyncState<Prefs>; onStarted: OnStarted }) {
  const { state, refresh } = useSourceList();
  const [job, setJob] = useState<Job | null>(null);
  const sources = state.status === "ok" ? state.sources : [];
  return (
    <section aria-labelledby="your-own" className="flex min-w-0 flex-col gap-3">
      <h2 id="your-own" className="section-label">
        Your own material
      </h2>
      <UploadCard
        open={panels.isOpen(UPLOAD_PANEL)}
        onOpen={() => panels.open(UPLOAD_PANEL)}
        onClose={() => panels.close(UPLOAD_PANEL)}
        job={job}
        setJob={setJob}
        source={job ? sources.find((s) => s.id === job.id) : undefined}
        usage={state.status === "ok" ? state.usage : null}
        prefs={prefs}
        onCreated={refresh}
        onStarted={onStarted}
      />
      {state.status === "error" && <ErrorNotice>We could not load your sources. {state.message}</ErrorNotice>}
      <SourceRows
        sources={sources}
        isOpen={(id) => panels.isOpen(srcPanel(id))}
        onToggle={(id) => (panels.isOpen(srcPanel(id)) ? panels.close(srcPanel(id)) : panels.open(srcPanel(id)))}
        onClose={(id) => panels.close(srcPanel(id))}
        onTryAnother={() => {
          setJob(null);
          panels.open(UPLOAD_PANEL);
        }}
        prefs={prefs}
        onStarted={onStarted}
      />
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
  return (
    <div className="flex flex-col gap-3">
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

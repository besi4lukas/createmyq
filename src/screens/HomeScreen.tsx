import { useRef } from "react";
import { ArrowCounterClockwise, ArrowRight, PlayPause, UploadSimple } from "@phosphor-icons/react";
import { useUser } from "@clerk/react";
import { Button } from "../components/Button";
import { ErrorNotice } from "../components/Bits";
import { navigate } from "../lib/router";
import { CATEGORIES, difficultyLabel, getActiveQuiz, quizTitle, type Quiz } from "../lib/quiz";
import { useAsync } from "../lib/useAsync";
import { useUpload } from "../lib/uploads";
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
        <p className="mt-1.5 text-muted">Take a built-in quiz and see what you actually know.</p>
      </div>

      {active.status === "ok" && active.data && <ResumeCard quiz={active.data} />}
      {active.status === "error" && (
        <ErrorNotice>
          We could not check for a quiz in progress. {active.message}
        </ErrorNotice>
      )}

      {active.status === "ok" && !active.data && <ReviewCard onStarted={onStarted} />}

      <section aria-labelledby="builtin" className="flex max-w-[486px] flex-col gap-3">
        <h2 id="builtin" className="section-label">
          Built-in
        </h2>
        {CATEGORIES.map((c) => (
          <div key={c.slug} className="flex flex-col gap-2 rounded-md bg-surface p-4.5">
            <div className="kicker">Multiple choice, three levels</div>
            <h3 className="text-title leading-tight">{c.name}</h3>
            <p className="text-small opacity-80">{c.blurb}</p>
            <div className="mt-1.5">
              <Button onClick={() => navigate({ name: "setup", category: c.slug })}>
                Start a quiz
                <ArrowRight aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </section>

      <UploadSection />
    </div>
  );
}

/**
 * STM-13: upload a PDF straight to storage and show the source's status. Only
 * the signed-URL path; generation progress and the library come later.
 */
function UploadSection() {
  const input = useRef<HTMLInputElement>(null);
  const { state, upload } = useUpload();
  const busy = state.status === "uploading";

  return (
    <section aria-labelledby="your-own" className="flex max-w-[486px] flex-col gap-3">
      <h2 id="your-own" className="section-label">
        Your own
      </h2>
      <div className="flex flex-col gap-2 rounded-md bg-surface p-4.5">
        <div className="kicker">PDF, up to 20 MB</div>
        <h3 className="text-title leading-tight">Upload a PDF</h3>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
        <div className="mt-1.5">
          <Button disabled={busy} onClick={() => input.current?.click()}>
            <UploadSimple aria-hidden="true" className="size-4" />
            Choose a PDF
          </Button>
        </div>
        <div role="status" className="text-small text-muted">
          {state.status === "uploading" && `Uploading ${state.filename}…`}
          {state.status === "done" && `Uploaded ${state.source.title ?? "your PDF"}. Status: ${state.source.status}.`}
        </div>
        {state.status === "error" && <ErrorNotice>{state.message}</ErrorNotice>}
      </div>
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

/**
 * Home's upload tile and the card it opens into (INLINE_UPLOAD_AND_SOURCES_UPDATE,
 * section A). The card steps through form → processing → refused/failed →
 * setup without leaving Home; "Start quiz" goes straight to Q1.
 *
 * The job (the source being made) belongs to the column, not the card, and
 * its status is the server's (the source list, polled while anything is
 * working). So closing the card mid-job cancels nothing: the run goes on, its
 * row in the list below shows how it is doing, and reopening the card shows
 * where it is now. Any other close (Later, after an outcome) forgets the job;
 * the source stays in the list.
 */
import { useEffect, useId, useRef, useState } from "react";
import { ArrowCounterClockwise, CaretDown, CaretUp, CheckCircle, FilePdf, Info, LinkSimple, YoutubeLogo } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/Button";
import { ProcessingSteps } from "../components/ProcessingSteps";
import { SubjectRefusal } from "../components/SubjectRefusal";
import { UploadForm } from "../components/UploadForm";
import { panelEnter } from "../lib/motion";
import type { Prefs } from "../lib/quiz";
import { FAILED_FALLBACK, REFUSED_FALLBACK, type Source, type Usage } from "../lib/sources";
import { FORM_SUBTITLE, READY_PAUSE_MS, cardPhase, cardTitle, readyBanner, sourceName } from "../lib/upload-card";
import type { AsyncState } from "../lib/useAsync";
import { InlineSetup, type OnStarted } from "./InlineSetup";
import { focusFirst, useReturnFocus } from "./useReturnFocus";

export type Job = { id: string; name: string };

export function UploadCard({
  open,
  onOpen,
  onClose,
  job,
  setJob,
  source,
  usage,
  prefs,
  onCreated,
  onStarted,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  job: Job | null;
  setJob: (job: Job | null) => void;
  /** The job's source from the list, once the list has it. */
  source: Source | undefined;
  usage: Usage | null;
  prefs: AsyncState<Prefs>;
  /** A source was created: the list reloads so it shows up and is polled. */
  onCreated: () => void;
  onStarted: OnStarted;
}) {
  const cardId = useId();
  const { toggleRef, returnFocus } = useReturnFocus<HTMLButtonElement>(open);

  if (!open) {
    return (
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={false}
        aria-controls={cardId}
        onClick={onOpen}
        className="flex flex-col items-start gap-2.5 rounded-md border border-dashed border-accent/55 bg-accent/5 p-4.5 text-left text-text transition-colors hover:bg-accent/11"
      >
        <span aria-hidden="true" className="flex w-full items-center gap-2 text-accent">
          <FilePdf className="size-5.5" />
          <LinkSimple className="size-5.5" />
          <YoutubeLogo className="size-5.5" />
          <CaretDown className="ml-auto size-4 text-neutral-400" />
        </span>
        <span className="text-title font-medium">Make a quiz from something you’re reading</span>
        <span className="text-small text-muted">
          A PDF, an article link or a YouTube video with captions. Takes about two minutes.
        </span>
      </button>
    );
  }

  return (
    <OpenCard
      id={cardId}
      job={job}
      setJob={setJob}
      source={source}
      usage={usage}
      prefs={prefs}
      onCreated={onCreated}
      onStarted={onStarted}
      close={(keepJob) => {
        if (!keepJob) setJob(null);
        returnFocus();
        onClose();
      }}
    />
  );
}

function OpenCard({
  id,
  job,
  setJob,
  source,
  usage,
  prefs,
  onCreated,
  onStarted,
  close,
}: {
  id: string;
  job: Job | null;
  setJob: (job: Job | null) => void;
  source: Source | undefined;
  usage: Usage | null;
  prefs: AsyncState<Prefs>;
  onCreated: () => void;
  onStarted: OnStarted;
  /** keepJob: closing mid-run keeps the job so reopening shows where it is. */
  close: (keepJob: boolean) => void;
}) {
  const reduce = useReducedMotion();
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // Ready: the finished steps stay up for a moment, then setup comes on its own.
  const ready = source?.status === "ready";
  const [pauseOverFor, setPauseOverFor] = useState<string | null>(null);
  useEffect(() => {
    if (!ready || !job) return;
    const t = setTimeout(() => setPauseOverFor(job.id), READY_PAUSE_MS);
    return () => clearTimeout(t);
  }, [ready, job]);

  const phase = cardPhase(job?.id ?? null, source, pauseOverFor !== job?.id);
  const title = cardTitle(phase, source);
  const subtitle = phase === "form" ? FORM_SUBTITLE : sourceName(source, job?.name);

  // On open, focus the first control in the body (or the body itself). On each
  // later phase, the same, unless the user has moved on to something outside
  // the card while it worked.
  const opened = useRef(false);
  useEffect(() => {
    const active = document.activeElement;
    const elsewhere = active && active !== document.body && !card.current?.contains(active);
    if (opened.current && elsewhere) return;
    opened.current = true;
    focusFirst(body.current);
  }, [phase]);

  const tryAgain = (
    <Button onClick={() => setJob(null)}>
      <ArrowCounterClockwise aria-hidden="true" className="size-4" />
      Try another source
    </Button>
  );

  return (
    <div
      ref={card}
      id={id}
      className="flex flex-col gap-4 rounded-md bg-surface p-4.5 shadow-md"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close(phase === "processing");
        }
      }}
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1" aria-live="polite">
          <h3 className="text-title font-medium leading-tight">{title}</h3>
          <p className="mt-1 text-small break-words opacity-80">{subtitle}</p>
        </div>
        <Button
          variant="ghost"
          className="size-11 shrink-0 px-0 text-neutral-400"
          aria-label="Close"
          aria-expanded={true}
          aria-controls={id}
          onClick={() => close(phase === "processing")}
        >
          <CaretUp aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <motion.div
        key={phase}
        ref={body}
        tabIndex={-1}
        initial={reduce ? false : panelEnter.initial}
        animate={panelEnter.animate}
        transition={panelEnter.transition}
        className="rule-fade-top flex flex-col gap-4 pt-4 outline-none"
      >
        {phase === "form" && (
          <UploadForm
            compact
            usage={usage}
            onCreated={(created) => {
              setJob(created);
              onCreated();
            }}
          />
        )}

        {phase === "processing" && (
          <>
            <ProcessingSteps
              compact
              source={
                source ?? { id: job!.id, bankSourceId: job!.id, status: "uploaded", fingerprinted: false, gateVerdict: null }
              }
            />
            <p className="flex items-center gap-2 text-meta text-muted">
              <Info aria-hidden="true" className="size-4 shrink-0" />
              You can close this. It keeps going and lands in your sources below.
            </p>
          </>
        )}

        {(phase === "refused" || phase === "failed") && source && (
          <SubjectRefusal
            compact
            variant={phase}
            message={source.error ?? (phase === "refused" ? REFUSED_FALLBACK : FAILED_FALLBACK)}
            detectedNiche={source.detectedNiche}
            confidence={source.confidence}
            actions={tryAgain}
          />
        )}

        {phase === "setup" && source && (
          <>
            <ReadyBanner source={source} />
            <InlineSetup
              target={{ sourceId: source.id }}
              prefs={prefs}
              onStarted={onStarted}
              secondary={
                <Button variant="ghost" className="px-2.5" onClick={() => close(false)}>
                  Later
                </Button>
              }
            />
          </>
        )}
      </motion.div>
    </div>
  );
}

function ReadyBanner({ source }: { source: Source }) {
  const { lead, body } = readyBanner(source);
  return (
    <div className="flex items-start gap-2.5 rounded-md bg-accent-900 px-3.5 py-3">
      <CheckCircle aria-hidden="true" weight="fill" className="size-5 shrink-0 text-accent-300" />
      <p className="text-small text-accent-100 text-pretty">
        <span className="font-medium">{lead}</span> {body}
      </p>
    </div>
  );
}

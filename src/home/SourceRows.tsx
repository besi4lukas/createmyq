/**
 * The user's saved sources under the upload card (INLINE_UPLOAD_AND_SOURCES_UPDATE,
 * section B). Each row is an accordion item sharing Home's one open panel: a
 * ready source opens its quiz setup in place ("Start quiz" goes to Q1); one
 * still working shows its steps; a refused or failed one says why.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { ArrowCounterClockwise, CaretDown, CaretUp, FilePdf, LinkSimple, YoutubeLogo, type Icon } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/Button";
import { ProcessingSteps } from "../components/ProcessingSteps";
import { SubjectRefusal } from "../components/SubjectRefusal";
import { panelEnter } from "../lib/motion";
import type { Prefs } from "../lib/quiz";
import { FAILED_FALLBACK, REFUSED_FALLBACK, isWorking, type Source, type SourceKind } from "../lib/sources";
import { rowMeta, sourceName } from "../lib/upload-card";
import type { AsyncState } from "../lib/useAsync";
import { InlineSetup, type OnStarted } from "./InlineSetup";
import { focusFirst, useReturnFocus } from "./useReturnFocus";

const KIND_ICON: Record<SourceKind, Icon> = { pdf: FilePdf, article: LinkSimple, youtube: YoutubeLogo };

export function SourceRows({
  sources,
  isOpen,
  onToggle,
  onClose,
  onTryAnother,
  prefs,
  onStarted,
}: {
  sources: Source[];
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
  onClose: (id: string) => void;
  /** "Try another source" on a refused row: opens the upload card. */
  onTryAnother: () => void;
  prefs: AsyncState<Prefs>;
  onStarted: OnStarted;
}) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label="Your sources" className="flex flex-col gap-1">
      {sources.map((s) => (
        <SourceRow
          key={s.id}
          source={s}
          open={isOpen(s.id)}
          onToggle={() => onToggle(s.id)}
          onClose={() => onClose(s.id)}
          onTryAnother={onTryAnother}
          prefs={prefs}
          onStarted={onStarted}
        />
      ))}
    </ul>
  );
}

function SourceRow({
  source,
  open,
  onToggle,
  onClose,
  onTryAnother,
  prefs,
  onStarted,
}: {
  source: Source;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onTryAnother: () => void;
  prefs: AsyncState<Prefs>;
  onStarted: OnStarted;
}) {
  const panelId = useId();
  const { toggleRef, returnFocus } = useReturnFocus<HTMLButtonElement>(open);
  const KindIcon = KIND_ICON[source.kind];
  const Caret = open ? CaretUp : CaretDown;
  const closeFromInside = () => {
    returnFocus();
    onClose();
  };

  return (
    <li
      className={`rounded-md transition-[background-color,box-shadow] duration-250 ${open ? "bg-surface shadow-md" : "bg-transparent"}`}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.preventDefault();
          closeFromInside();
        }
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-14 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-text hover:bg-text/5"
      >
        <KindIcon aria-hidden="true" className="size-5 shrink-0 text-neutral-400" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui">{sourceName(source)}</span>
          <span className="block text-meta text-muted">{rowMeta(source)}</span>
        </span>
        <Caret aria-hidden="true" className="size-4 shrink-0 text-neutral-500" />
      </button>
      {open && (
        <RowPanelShell id={panelId}>
          <RowPanel source={source} prefs={prefs} onStarted={onStarted} onCancel={closeFromInside} onTryAnother={onTryAnother} />
        </RowPanelShell>
      )}
    </li>
  );
}

/** The open row's panel: fades down into place, and takes focus once, when it opens. */
function RowPanelShell({ id, children }: { id: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => focusFirst(ref.current), []);
  return (
    <motion.div
      ref={ref}
      id={id}
      tabIndex={-1}
      initial={reduce ? false : panelEnter.initial}
      animate={panelEnter.animate}
      transition={panelEnter.transition}
      className="rule-fade-top mx-4.5 flex flex-col gap-4 pt-4 pb-4.5 outline-none"
    >
      {children}
    </motion.div>
  );
}

function RowPanel({
  source,
  prefs,
  onStarted,
  onCancel,
  onTryAnother,
}: {
  source: Source;
  prefs: AsyncState<Prefs>;
  onStarted: OnStarted;
  onCancel: () => void;
  onTryAnother: () => void;
}) {
  if (source.status === "ready") {
    return (
      <InlineSetup
        target={{ sourceId: source.id }}
        prefs={prefs}
        onStarted={onStarted}
        secondary={
          <Button variant="ghost" className="px-2.5" onClick={onCancel}>
            Cancel
          </Button>
        }
      />
    );
  }
  if (isWorking(source.status)) return <ProcessingSteps compact source={source} />;
  const refused = source.status === "refused";
  return (
    <SubjectRefusal
      compact
      variant={refused ? "refused" : "failed"}
      message={source.error ?? (refused ? REFUSED_FALLBACK : FAILED_FALLBACK)}
      detectedNiche={source.detectedNiche}
      confidence={source.confidence}
      actions={
        <Button onClick={onTryAnother}>
          <ArrowCounterClockwise aria-hidden="true" className="size-4" />
          Try another source
        </Button>
      }
    />
  );
}

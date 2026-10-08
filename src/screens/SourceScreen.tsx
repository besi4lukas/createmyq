/**
 * One source and its status (design v2, screens 6 "Processing" and 7 "Subject
 * gate refusal"), polled until the background run finishes. Safe to leave and
 * come back to: /sources/<id> is a real URL.
 *
 * The server only knows the run's overall status, not which step it is on, so
 * this shows one honest "working" row with the time so far instead of the
 * design's six-step list (see TASKS.md). Every outcome is said in words and an
 * icon, never by colour alone.
 */
import { useEffect, useState } from "react";
import {
  ArrowCounterClockwise,
  CheckCircle,
  CircleNotch,
  FilePdf,
  Info,
  LinkSimple,
  XCircle,
  YoutubeLogo,
  type Icon,
} from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading, Tag } from "../components/Bits";
import { revealEnter } from "../lib/motion";
import { navigate } from "../lib/router";
import { elapsed, sourceView, useSourceStatus, type Source, type SourceKind } from "../lib/sources";

const KIND_ICON: Record<SourceKind, Icon> = { pdf: FilePdf, article: LinkSimple, youtube: YoutubeLogo };
const WORKS_WELL = [
  "System design",
  "Algorithms and data structures",
  "Databases",
  "Networking",
  "Languages and runtimes",
  "Concurrency",
];

export function SourceScreen({ id }: { id: string }) {
  const state = useSourceStatus(id);
  if (state.status === "loading") return <Loading label="Loading your source" />;
  if (state.status === "error" && !state.last) {
    return (
      <div className="flex max-w-[560px] flex-col gap-4 pt-3">
        <ErrorNotice action={<Button onClick={() => navigate({ name: "add" })}>Add a source</Button>}>
          {state.message}
        </ErrorNotice>
      </div>
    );
  }
  const source = state.status === "ok" ? state.source : state.last!;
  return (
    <>
      <SourceView source={source} />
      {state.status === "error" && (
        <div className="mt-4 max-w-[560px]">
          <ErrorNotice>Could not check the status just now. Trying again… {state.message}</ErrorNotice>
        </div>
      )}
    </>
  );
}

function SourceName({ source }: { source: Source }) {
  const KindIcon = KIND_ICON[source.kind];
  const name = source.title ?? source.url ?? "Your source";
  return (
    <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-small text-muted">
      <KindIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="truncate">{name}</span>
    </p>
  );
}

function SourceView({ source }: { source: Source }) {
  const view = sourceView(source);
  const reduce = useReducedMotion();
  const again = (
    <Button onClick={() => navigate({ name: "add" })}>
      <ArrowCounterClockwise aria-hidden="true" className="size-4" />
      Try another source
    </Button>
  );

  if (view.phase === "refused") {
    return (
      <div className="flex max-w-[540px] flex-col gap-4.5 pt-6">
        <span aria-hidden="true" className="grid size-13 place-items-center rounded-lg bg-neutral-900 text-neutral-300">
          <XCircle className="size-6.5" />
        </span>
        <div>
          <h1 data-autofocus tabIndex={-1} className="text-h2-phone sm:text-h2 text-balance outline-none">
            {view.title}
          </h1>
          <SourceName source={source} />
        </div>
        <p className="text-body text-pretty">{view.message}</p>
        <div className="flex flex-col gap-2">
          <p className="text-meta text-muted">Things that work well</p>
          <div className="flex flex-wrap gap-1.5">
            {WORKS_WELL.map((t) => (
              <Tag key={t} tone="accent">
                {t}
              </Tag>
            ))}
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-2.5">
          {again}
          <Button variant="secondary" onClick={() => navigate({ name: "home" })}>
            Take a built-in quiz
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[560px] flex-col gap-5.5 pt-3">
      <div>
        <div className="kicker mb-1.5">{view.kicker}</div>
        <h1 data-autofocus tabIndex={-1} className="text-h2-phone sm:text-h2 outline-none">
          {view.title}
        </h1>
        <SourceName source={source} />
      </div>

      {view.phase === "working" && <Working since={source.createdAt} />}

      {view.phase === "ready" && (
        <motion.div {...revealEnter} initial={reduce ? false : revealEnter.initial} className="flex flex-col gap-2.5 rounded-md bg-surface p-4.5 shadow-md">
          <div className="flex items-center gap-2.5">
            <CheckCircle aria-hidden="true" weight="fill" className="size-6 text-accent" />
            <div className="text-title">
              {view.cached ? `${view.count} questions, ready now` : `${view.count} questions made`}
            </div>
          </div>
          <p className="text-small text-pretty">
            {view.cached
              ? "Someone in the group brought the same text. Nothing had to be generated, and it didn’t count toward your limit."
              : "Every one points back to the part of the text it came from."}
          </p>
          <p className="text-meta text-muted text-pretty">
            Taking a quiz from your own source isn’t in the app yet. Your questions are saved for when it is.
          </p>
          <div className="mt-1 flex flex-wrap gap-2.5">
            <Button onClick={() => navigate({ name: "add" })}>Add another source</Button>
            <Button variant="secondary" onClick={() => navigate({ name: "home" })}>
              Home
            </Button>
          </div>
        </motion.div>
      )}

      {view.phase === "failed" && (
        <>
          <div role="alert" className="flex gap-3 rounded-md border border-wrong-bd bg-wrong-bg px-4 py-3.5">
            <XCircle aria-hidden="true" weight="fill" className="mt-px size-5.5 shrink-0 text-wrong" />
            <p className="text-ui text-pretty">{view.message}</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {again}
            <Button variant="secondary" onClick={() => navigate({ name: "home" })}>
              Home
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Working({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <div className="flex gap-3.5 py-3">
        <CircleNotch aria-hidden="true" className="size-5.5 shrink-0 animate-spin text-accent-300" />
        <div className="flex-1">
          <div className="text-ui">Reading, checking the subject, writing questions</div>
          <div className="text-meta text-muted">
            We check it’s about software, then aim for 20 to 25 questions. Usually about two minutes.
          </div>
        </div>
        <span className="text-meta text-muted tabular-nums" aria-label="Time so far">
          {elapsed(since, now)}
        </span>
      </div>
      <p className="flex items-center gap-2 text-meta text-muted">
        <Info aria-hidden="true" className="size-4 shrink-0" />
        You can close this page. It keeps going, and this page’s link shows the result.
      </p>
    </>
  );
}

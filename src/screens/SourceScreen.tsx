/**
 * One source and its status (design v2, screens 6 "Processing" and 7 "Subject
 * gate refusal"), polled until the background run finishes. Safe to leave and
 * come back to: /sources/<id> is a real URL. Home shows the same steps and
 * refusal inline (ProcessingSteps, SubjectRefusal); this page stays for deep
 * links.
 *
 * The steps come from what the run has written so far (src/lib/steps.ts), so
 * a step is never shown done before the server knows it is. Every outcome is
 * said in words and an icon, never by colour alone.
 */
import {
  ArrowCounterClockwise,
  ArrowRight,
  CheckCircle,
  FilePdf,
  Info,
  LinkSimple,
  XCircle,
  YoutubeLogo,
  type Icon,
} from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/Button";
import { ErrorNotice, Loading } from "../components/Bits";
import { ProcessingSteps } from "../components/ProcessingSteps";
import { SubjectRefusal } from "../components/SubjectRefusal";
import { revealEnter } from "../lib/motion";
import { navigate } from "../lib/router";
import { sourceView, useSourceStatus, type Source, type SourceKind } from "../lib/sources";
import { readyBanner } from "../lib/upload-card";

const KIND_ICON: Record<SourceKind, Icon> = { pdf: FilePdf, article: LinkSimple, youtube: YoutubeLogo };

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
      <SubjectRefusal
        variant="refused"
        message={view.message}
        detectedNiche={source.detectedNiche}
        confidence={source.confidence}
        name={<SourceName source={source} />}
        actions={
          <>
            {again}
            <Button variant="secondary" onClick={() => navigate({ name: "home" })}>
              Take a built-in quiz
            </Button>
          </>
        }
      />
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

      {(view.phase === "working" || view.phase === "ready") && <ProcessingSteps source={source} />}

      {view.phase === "working" && (
        <p className="flex items-center gap-2 text-meta text-muted">
          <Info aria-hidden="true" className="size-4 shrink-0" />
          You can close this page. It keeps going, and your quiz will be on the home screen.
        </p>
      )}

      {view.phase === "ready" && (
        <motion.div {...revealEnter} initial={reduce ? false : revealEnter.initial} className="flex flex-col gap-2.5 rounded-md bg-surface p-4.5 shadow-md">
          <div className="flex items-center gap-2.5">
            <CheckCircle aria-hidden="true" weight="fill" className="size-6 text-accent" />
            <div className="text-title">{readyBanner(source).lead.replace(/\.$/, "")}</div>
          </div>
          <p className="text-small text-pretty">{readyBanner(source).body}</p>
          <div className="mt-1 flex flex-wrap gap-2.5">
            <Button onClick={() => navigate({ name: "source-setup", id: source.id })}>
              Set up the quiz
              <ArrowRight aria-hidden="true" className="size-4" />
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

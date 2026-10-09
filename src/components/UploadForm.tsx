/**
 * "Bring your own material": a PDF, an article link or a YouTube link becomes
 * a source. Shared by the add-source page (/add) and Home's inline upload card
 * (`compact`, which shrinks the dropzone and shows today's usage). The parent
 * decides what happens once the source exists (`onCreated`).
 *
 * Not built (see TASKS.md): the "Share with the group" switch (FR-10a has no
 * server side yet). The daily cap shows up as a notice when the usage the
 * parent passed says it is reached, or when the server refuses; the spend
 * ceiling only when the server refuses.
 */
import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { FilePdf, HourglassMedium, LinkSimple, Sparkle, UploadSimple, YoutubeLogo } from "@phosphor-icons/react";
import { ApiError, friendlyError } from "../lib/api";
import { KINDS, checkLinkInput, checkPdfFile, formatBytes, submitLink, type SourceKind, type Usage } from "../lib/sources";
import { isCapped, usageLabel } from "../lib/upload-card";
import { uploadPdf } from "../lib/uploads";
import { ErrorNotice } from "./Bits";
import { Button } from "./Button";
import { Segmented, type SegmentOption } from "./Segmented";

const KIND_ICONS: Record<SourceKind, typeof FilePdf> = { pdf: FilePdf, article: LinkSimple, youtube: YoutubeLogo };
const kindOptions: SegmentOption<SourceKind>[] = KINDS.map((k) => {
  const Icon = KIND_ICONS[k.value];
  return { ...k, icon: <Icon aria-hidden="true" className="size-4" /> };
});

/** A refusal that isn't about this source: today's cap, or the monthly spend ceiling. */
type Limit = { code: "daily_cap" | "spend_ceiling"; message: string };
type Phase = { status: "idle" } | { status: "sending" } | { status: "error"; message: string } | { status: "limit"; limit: Limit };

/** Used when the usage says the cap is reached but carries no message (it always should). */
const CAP_FALLBACK = "You have hit today's limit. It resets at midnight.";

export function UploadForm({
  compact = false,
  usage = null,
  onCreated,
}: {
  compact?: boolean;
  /** Today's usage (Home): shows "{n} of {cap} sources used today", and the cap notice before anything is sent. */
  usage?: Usage | null;
  /** The source exists and its run is queued. `name` is what the user picked: the file name or the link. */
  onCreated: (source: { id: string; name: string }) => void;
}) {
  const [kind, setKind] = useState<SourceKind>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  // One id per link: a retry of the same link (a timeout, a double press) is the same source.
  const request = useRef<{ url: string; id: string } | null>(null);
  const busy = phase.status === "sending";
  const capLimit: Limit | null =
    phase.status === "limit"
      ? phase.limit
      : usage && isCapped(usage)
        ? { code: "daily_cap", message: usage.message ?? CAP_FALLBACK }
        : null;
  const capped = capLimit !== null;

  const pick = (k: SourceKind) => {
    setKind(k);
    if (phase.status === "error") setPhase({ status: "idle" });
  };

  const choose = (f: File | null) => {
    setFile(f);
    const problem = f ? checkPdfFile(f) : null;
    setPhase(problem ? { status: "error", message: problem } : { status: "idle" });
  };

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy || capped) return;
    const problem =
      kind === "pdf" ? (file ? checkPdfFile(file) : "Choose a PDF first.") : checkLinkInput(kind, url);
    if (problem) {
      setPhase({ status: "error", message: problem });
      return;
    }
    setPhase({ status: "sending" });
    try {
      if (kind === "pdf") {
        const { id } = await uploadPdf(file!);
        onCreated({ id, name: file!.name });
      } else {
        const link = url.trim();
        if (request.current?.url !== link) request.current = { url: link, id: crypto.randomUUID() };
        const { id } = await submitLink(url, request.current.id);
        onCreated({ id, name: link });
      }
    } catch (err) {
      if (err instanceof ApiError && (err.code === "daily_cap" || err.code === "spend_ceiling")) {
        setPhase({ status: "limit", limit: { code: err.code, message: err.message } });
      } else {
        setPhase({ status: "error", message: friendlyError(err) });
      }
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className={`flex flex-col ${compact ? "gap-4" : "gap-5.5"}`}>
      <Segmented label="What are you bringing?" hideLabel options={kindOptions} value={kind} onChange={pick} />

      {kind === "pdf" ? (
        <PdfDrop file={file} onFile={choose} disabled={busy} compact={compact} />
      ) : (
        <LinkField kind={kind} value={url} onChange={setUrl} disabled={busy} invalid={phase.status === "error"} />
      )}

      {phase.status === "error" && <ErrorNotice>{phase.message}</ErrorNotice>}
      {capLimit && <LimitNotice limit={capLimit} compact={compact} />}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={busy || capped}>
          <Sparkle aria-hidden="true" className="size-4.5" />
          Make my quiz
        </Button>
        <span role="status" className="text-meta text-muted">
          {busy ? (kind === "pdf" ? "Uploading your PDF…" : "Sending your link…") : usage ? usageLabel(usage) : ""}
        </span>
      </div>
    </form>
  );
}

function PdfDrop({
  file,
  onFile,
  disabled,
  compact,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  disabled: boolean;
  compact: boolean;
}) {
  const [over, setOver] = useState(false);
  const hintId = useId();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) onFile(e.dataTransfer.files[0] ?? null);
  };
  const Icon = file ? FilePdf : UploadSimple;
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex flex-col items-start rounded-md border border-dashed transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent hover:border-accent ${
        compact ? "gap-1.5 bg-bg px-4.5 py-5" : "gap-2 bg-surface px-5.5 py-7"
      } ${over ? "border-accent" : "border-neutral-600"}`}
    >
      <input
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      <Icon aria-hidden="true" className={`text-accent ${compact ? "size-6.5" : "size-7.5"}`} />
      <span className={`break-all ${compact ? "text-ui" : "text-body"}`}>
        {file ? file.name : "Drop a PDF here, or tap to choose"}
      </span>
      <span id={hintId} className="text-meta text-muted">
        {file
          ? `${formatBytes(file.size)}, tap to replace`
          : "Up to 50 pages and 20 MB. Scanned PDFs without text won’t work."}
      </span>
    </label>
  );
}

function LinkField({
  kind,
  value,
  onChange,
  disabled,
  invalid,
}: {
  kind: "article" | "youtube";
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-[5px] block text-meta text-label">
        {kind === "youtube" ? "YouTube link" : "Article link"}
      </label>
      <input
        id={id}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        placeholder={kind === "youtube" ? "https://youtube.com/watch?v=…  (needs captions)" : "https://…"}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 w-full rounded-md border border-divider bg-surface px-2.5 text-ui text-text caret-accent placeholder:text-muted hover:border-text/45 focus-visible:border-accent focus-visible:outline-offset-0 aria-invalid:border-wrong-bd disabled:opacity-45"
      />
    </div>
  );
}

/** The cap or ceiling notice. The page's panel has the resting shadow; the card's has none (it already sits on a raised card). */
function LimitNotice({ limit, compact }: { limit: Limit; compact: boolean }) {
  return (
    <div role="alert" className={`flex gap-3 rounded-md bg-neutral-900 px-4 py-3.5 ${compact ? "" : "shadow-sm"}`}>
      <HourglassMedium aria-hidden="true" className="size-5.5 shrink-0 text-accent" />
      <div>
        <div className="mb-0.5 text-ui">
          {limit.code === "daily_cap" ? "That’s all for today." : "New quizzes are paused."}
        </div>
        <div className="text-small text-muted text-pretty">
          {limit.message}
          {limit.code === "daily_cap" && " Built-in quizzes and your saved sources are still open."}
        </div>
      </div>
    </div>
  );
}

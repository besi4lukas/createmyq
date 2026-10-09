/**
 * "Bring your own material" (design v2, screen 5): a PDF, an article link or a
 * YouTube link. On success the user lands on the source's status screen.
 *
 * Not built yet (see TASKS.md): the "Share with the group" switch and the
 * "{n} of 3 sources used today" line. The daily cap and the spend ceiling
 * show up as a notice when the server refuses.
 */
import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { FilePdf, HourglassMedium, LinkSimple, Sparkle, UploadSimple, YoutubeLogo } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { ErrorNotice } from "../components/Bits";
import { Segmented, type SegmentOption } from "../components/Segmented";
import { ApiError, friendlyError } from "../lib/api";
import { navigate } from "../lib/router";
import { KINDS, checkLinkInput, checkPdfFile, formatBytes, submitLink, type SourceKind } from "../lib/sources";
import { uploadPdf } from "../lib/uploads";

const KIND_ICONS: Record<SourceKind, typeof FilePdf> = { pdf: FilePdf, article: LinkSimple, youtube: YoutubeLogo };
const kindOptions: SegmentOption<SourceKind>[] = KINDS.map((k) => {
  const Icon = KIND_ICONS[k.value];
  return { ...k, icon: <Icon aria-hidden="true" className="size-4" /> };
});

/** A refusal that isn't about this source: today's cap, or the monthly spend ceiling. */
type Limit = { code: "daily_cap" | "spend_ceiling"; message: string };
type Phase = { status: "idle" } | { status: "sending" } | { status: "error"; message: string } | { status: "limit"; limit: Limit };

export function AddSourceScreen() {
  const [kind, setKind] = useState<SourceKind>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  // One id per link: a retry of the same link (a timeout, a double press) is the same source.
  const request = useRef<{ url: string; id: string } | null>(null);
  const busy = phase.status === "sending";
  const capped = phase.status === "limit";

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
      let id: string;
      if (kind === "pdf") {
        id = (await uploadPdf(file!)).id;
      } else {
        if (request.current?.url !== url.trim()) request.current = { url: url.trim(), id: crypto.randomUUID() };
        id = (await submitLink(url, request.current.id)).id;
      }
      navigate({ name: "source", id });
    } catch (err) {
      if (err instanceof ApiError && (err.code === "daily_cap" || err.code === "spend_ceiling")) {
        setPhase({ status: "limit", limit: { code: err.code, message: err.message } });
      } else {
        setPhase({ status: "error", message: friendlyError(err) });
      }
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex max-w-[600px] flex-col gap-5.5 pt-3">
      <div>
        <h1 className="text-h2-phone sm:text-h2">Bring your own material</h1>
        <p className="mt-1.5 text-muted text-pretty">
          Anything about software engineering. We’ll read it, check it’s on topic, and write 20 to 25 questions.
        </p>
      </div>

      <Segmented label="What are you bringing?" hideLabel options={kindOptions} value={kind} onChange={pick} />

      {kind === "pdf" ? (
        <PdfDrop file={file} onFile={choose} disabled={busy} />
      ) : (
        <LinkField kind={kind} value={url} onChange={setUrl} disabled={busy} invalid={phase.status === "error"} />
      )}

      {phase.status === "error" && <ErrorNotice>{phase.message}</ErrorNotice>}
      {phase.status === "limit" && <LimitNotice limit={phase.limit} />}

      <div className="flex flex-wrap items-center gap-3.5">
        <Button type="submit" size="lg" disabled={busy || capped}>
          <Sparkle aria-hidden="true" className="size-4.5" />
          Make my quiz
        </Button>
        <span role="status" className="text-meta text-muted">
          {busy && (kind === "pdf" ? "Uploading your PDF…" : "Sending your link…")}
        </span>
      </div>
    </form>
  );
}

function PdfDrop({ file, onFile, disabled }: { file: File | null; onFile: (f: File | null) => void; disabled: boolean }) {
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
      className={`flex flex-col items-start gap-2 rounded-md border border-dashed bg-surface px-5.5 py-7 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent hover:border-accent ${over ? "border-accent" : "border-neutral-600"}`}
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
      <Icon aria-hidden="true" className="size-7.5 text-accent" />
      <span className="text-body break-all">{file ? file.name : "Drop a PDF here, or tap to choose"}</span>
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

function LimitNotice({ limit }: { limit: Limit }) {
  return (
    <div role="alert" className="flex gap-3 rounded-md bg-neutral-900 px-4 py-3.5 shadow-sm">
      <HourglassMedium aria-hidden="true" className="size-5.5 shrink-0 text-accent" />
      <div>
        <div className="mb-0.5 text-ui">
          {limit.code === "daily_cap" ? "That’s all for today." : "New quizzes are paused."}
        </div>
        <div className="text-small text-muted text-pretty">
          {limit.message}
          {limit.code === "daily_cap" && " Built-in quizzes are still open."}
        </div>
      </div>
    </div>
  );
}

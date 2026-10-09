/**
 * "This one’s not really our thing." (design v2, screen 7): the subject gate
 * said no. Shared by the source status page and Home's inline upload card and
 * source rows (`compact`). The compact form also carries the other failures
 * (no text extracted, too thin …) with their stored message and another icon.
 *
 * The message is the one the run stored, shown exactly (CLAUDE.md: "This looks
 * like {detected}. CreateMyQ only covers software engineering right now."),
 * with the topic in accent text, then how sure the gate was. The design's
 * "This didn’t count toward today’s limit." is not shown: a refusal does count
 * (STM-22: the gate runs after the spend reservation).
 */
import type { ReactNode } from "react";
import {
  AirplaneTilt,
  Atom,
  Brain,
  Briefcase,
  BookOpen,
  ChartBar,
  CookingPot,
  Cpu,
  CurrencyBtc,
  Dna,
  FileX,
  FirstAidKit,
  Flask,
  HandsPraying,
  Kanban,
  Lightning,
  MathOperations,
  MusicNotes,
  PaintBrush,
  PiggyBank,
  Plant,
  Question,
  Scales,
  Scroll,
  SoccerBall,
  Table,
  type Icon,
} from "@phosphor-icons/react";
import { confidencePercent, splitOnTopic } from "../lib/upload-card";
import { Tag } from "./Bits";

/** One icon per refusal label's phrase (worker/classifier/labels.ts); a topic the model named itself gets the question mark. */
const TOPIC_ICON: Record<string, Icon> = {
  cooking: CookingPot,
  "personal finance": PiggyBank,
  gardening: Plant,
  history: Scroll,
  sports: SoccerBall,
  fiction: BookOpen,
  music: MusicNotes,
  biology: Dna,
  "health and medicine": FirstAidKit,
  mathematics: MathOperations,
  physics: Atom,
  chemistry: Flask,
  "electrical engineering": Lightning,
  "computer hardware": Cpu,
  statistics: ChartBar,
  "office software help": Table,
  "cryptocurrency trading": CurrencyBtc,
  "business management": Briefcase,
  "product management": Kanban,
  "law and politics": Scales,
  "philosophy and religion": HandsPraying,
  travel: AirplaneTilt,
  art: PaintBrush,
  "psychology and self-help": Brain,
};

const WORKS_WELL = ["System design", "Algorithms and data structures", "Databases", "Networking", "Languages and runtimes", "Concurrency"];
const WORKS_WELL_SHORT = ["System design", "Algorithms", "Databases", "Networking", "Concurrency"];

export const REFUSED_TITLE = "This one’s not really our thing.";
export const FAILED_TITLE = "We couldn’t make a quiz from this.";

export function SubjectRefusal({
  variant,
  message,
  detectedNiche,
  confidence,
  compact = false,
  name,
  actions,
}: {
  /** refused: the subject gate; failed: anything else the run stored a message for. */
  variant: "refused" | "failed";
  message: string;
  detectedNiche: string | null;
  confidence: number | null;
  compact?: boolean;
  /** Page only: the source's name under the heading. */
  name?: ReactNode;
  actions: ReactNode;
}) {
  const refused = variant === "refused";
  const Glyph = refused ? (TOPIC_ICON[detectedNiche?.trim().toLowerCase() ?? ""] ?? Question) : FileX;
  const title = refused ? REFUSED_TITLE : FAILED_TITLE;
  const parts = refused ? splitOnTopic(message, detectedNiche) : null;
  const pct = refused ? confidencePercent(confidence) : null;
  const text = parts ? (
    <>
      {parts[0]}
      <span className="text-accent-300">{parts[1]}</span>
      {parts[2]}
    </>
  ) : (
    message
  );
  const sure = pct !== null && <span className="text-muted"> We’re about {pct}% sure.</span>;

  if (compact) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-panel bg-neutral-900 text-neutral-300">
            <Glyph className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-body font-medium leading-snug">{title}</p>
            <p className="mt-1 text-small text-pretty">
              {text}
              {sure}
            </p>
          </div>
        </div>
        {refused && (
          <div className="flex flex-wrap gap-1.5">
            {WORKS_WELL_SHORT.map((t) => (
              <Tag key={t} tone="accent">
                {t}
              </Tag>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2.5">{actions}</div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[540px] flex-col gap-4.5 pt-6">
      <span aria-hidden="true" className="grid size-13 place-items-center rounded-lg bg-neutral-900 text-neutral-300">
        <Glyph className="size-6.5" />
      </span>
      <div>
        <h1 data-autofocus tabIndex={-1} className="text-h2-phone sm:text-h2 text-balance outline-none">
          {title}
        </h1>
        {name}
      </div>
      <p className="text-body text-pretty">
        {text}
        {sure}
      </p>
      {refused && (
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
      )}
      <div className="mt-1.5 flex flex-wrap gap-2.5">{actions}</div>
    </div>
  );
}

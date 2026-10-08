import { useId } from "react";
import { ChatCircleText, CheckSquare, Square, Timer } from "@phosphor-icons/react";
import { DIFFICULTIES, DIFFICULTY_LABEL, MODE_LABEL, QUIZ_LENGTHS, type Mode } from "../lib/quiz";
import { FORMATS, FORMAT_AVAILABLE, FORMAT_LABEL, toggleFormat, type SetupValues } from "../lib/setup";
import { Segmented } from "./Segmented";

const MODE_HELP: Record<Mode, string> = {
  practice: "See the answer and why after every question.",
  exam: "No hints along the way. Everything is revealed at the end.",
};

const iconClass = "size-4";

/**
 * The quiz setup controls: Difficulty, Length and Feedback, and optionally
 * Question formats. Used by the Setup page and by the inline setup on Home's
 * category cards. Controlled: the parent holds the values and the start call.
 * Returns the fields side by side so the parent sets the gap between them.
 */
export function QuizSetupFields({
  values,
  onChange,
  showFormats = false,
}: {
  values: SetupValues;
  onChange: (values: SetupValues) => void;
  /** The format chips (Home only for now; quizzes are multiple choice either way). */
  showFormats?: boolean;
}) {
  const set = <K extends keyof SetupValues>(key: K) => (value: SetupValues[K]) => onChange({ ...values, [key]: value });
  return (
    <>
      <Segmented
        label="Difficulty"
        value={values.difficulty}
        onChange={set("difficulty")}
        options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABEL[d] }))}
      />
      <Segmented
        label="Length"
        value={values.length}
        onChange={set("length")}
        options={QUIZ_LENGTHS.map((n) => ({ value: n, label: String(n) }))}
      />
      <Segmented
        label="Feedback"
        value={values.mode}
        onChange={set("mode")}
        help={MODE_HELP[values.mode]}
        options={[
          { value: "practice", label: MODE_LABEL.practice, icon: <ChatCircleText aria-hidden="true" className={iconClass} /> },
          { value: "exam", label: MODE_LABEL.exam, icon: <Timer aria-hidden="true" className={iconClass} /> },
        ]}
      />
      {showFormats && (
        <FormatChips value={values.formats} onChange={set("formats")} />
      )}
    </>
  );
}

/**
 * Toggle chips (aria-pressed): at least one stays on, and a format a quiz
 * can't serve yet is shown off and disabled, with the reason under the chips.
 */
function FormatChips({ value, onChange }: { value: SetupValues["formats"]; onChange: (v: SetupValues["formats"]) => void }) {
  const labelId = useId();
  const helpId = useId();
  const unavailable = FORMATS.some((f) => !FORMAT_AVAILABLE[f]);
  return (
    <div role="group" aria-labelledby={labelId} className="min-w-0">
      <p id={labelId} className="mb-[5px] text-meta text-label">
        Question formats
      </p>
      <div className="flex flex-wrap gap-2">
        {FORMATS.map((f) => {
          const on = value.includes(f);
          const available = FORMAT_AVAILABLE[f];
          const Icon = on ? CheckSquare : Square;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              disabled={!available}
              aria-describedby={available ? undefined : helpId}
              onClick={() => onChange(toggleFormat(value, f))}
              className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3.5 text-ui disabled:cursor-not-allowed disabled:opacity-45 ${
                on
                  ? "border-accent text-accent-300 enabled:hover:bg-accent/10"
                  : "border-divider text-neutral-400 enabled:hover:bg-text/7"
              }`}
            >
              <Icon aria-hidden="true" className="size-4.5 shrink-0" />
              {FORMAT_LABEL[f]}
            </button>
          );
        })}
      </div>
      {unavailable && (
        <p id={helpId} className="mt-1.5 text-meta text-muted">
          Short answer questions are not available yet.
        </p>
      )}
    </div>
  );
}

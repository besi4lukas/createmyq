import { useId, type ReactNode } from "react";

export type SegmentOption<T extends string | number> = { value: T; label: string; icon?: ReactNode };

/**
 * One row of mutually exclusive options (difficulty, length, mode). Native radio
 * inputs, so Tab enters the group once, arrow keys move and select, and screen
 * readers announce "radio, 2 of 3" with no extra code.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  help,
  hideLabel = false,
}: {
  label: string;
  /** The legend stays for screen readers only (the design shows no label above the kind picker). */
  hideLabel?: boolean;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  help?: string;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className={hideLabel ? "sr-only" : "mb-[5px] text-meta text-label"}>{label}</legend>
      <div className="flex overflow-hidden rounded-md border border-divider">
        {options.map((o) => (
          <label
            key={o.value}
            className="relative inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 border-l border-divider px-2 text-small first:border-l-0 has-checked:text-accent has-checked:shadow-selected has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-accent [&:not(:has(:checked))]:hover:bg-text/7"
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.icon}
            {o.label}
          </label>
        ))}
      </div>
      {help && <p className="mt-1.5 text-meta text-muted">{help}</p>}
    </fieldset>
  );
}

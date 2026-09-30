import type { ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react";

/** The "Q" logo mark: a placeholder built from type and a border. */
export function LogoMark({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        large
          ? "grid size-11 place-items-center rounded-tile border border-accent text-h4 font-semibold text-accent shadow-glow"
          : "grid size-7 place-items-center rounded-md border border-accent text-ui font-semibold text-accent"
      }
    >
      Q
    </span>
  );
}

export function Tag({ tone, children }: { tone: "accent" | "neutral"; children: ReactNode }) {
  const colours = tone === "accent" ? "bg-accent-800 text-accent-100" : "bg-neutral-800 text-neutral-100";
  return (
    <span className={`inline-flex items-center rounded-tag px-2.5 py-[3px] text-tag tracking-[0.02em] ${colours}`}>
      {children}
    </span>
  );
}

/** A handled error: icon + text, never a stack trace. */
export function ErrorNotice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-3 rounded-md border border-wrong-bd bg-wrong-bg px-4 py-3.5 text-ui"
    >
      <WarningCircle aria-hidden="true" weight="fill" className="mt-px size-5.5 shrink-0 text-wrong" />
      <div className="min-w-40 flex-1">
        <span className="sr-only">Error: </span>
        {children}
      </div>
      {action}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p role="status" className="text-ui text-muted">
      {label}…
    </p>
  );
}

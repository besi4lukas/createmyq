import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";

const TOAST_MS = 2400;

/** One toast at a time, auto-dismissed after 2.4s. */
export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    setMessage(text);
    timer.current = setTimeout(() => setMessage(null), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { message, show };
}

/** The live region is always mounted so screen readers announce each message. */
export function Toast({ message }: { message: string | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(28px+env(safe-area-inset-bottom))] z-30 flex justify-center px-5"
    >
      {message && (
        <div className="flex items-center gap-2.5 rounded-panel bg-surface px-4 py-2.5 text-small shadow-md">
          <CheckCircle aria-hidden="true" weight="fill" className="size-4.5 shrink-0 text-accent" />
          {message}
        </div>
      )}
    </div>
  );
}

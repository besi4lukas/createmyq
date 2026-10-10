import { useEffect, useRef } from "react";

/**
 * Focus for a Home panel toggle: closing the panel with its own controls
 * (Cancel, Close, Later, Escape) hands focus back to the toggle; another
 * panel opening does not. `toggleRef` goes on the toggle, which may be
 * re-mounted when the panel closes (the upload tile).
 */
export function useReturnFocus<T extends HTMLElement>(open: boolean) {
  const toggleRef = useRef<T>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (open || !pending.current) return;
    pending.current = false;
    toggleRef.current?.focus();
  }, [open]);
  return {
    toggleRef,
    /** Call before closing from inside the panel. */
    returnFocus: () => {
      pending.current = true;
    },
  };
}

const FOCUSABLE = 'input[type="radio"]:checked, input:not([type="radio"]):not([disabled]), button:not([disabled]), textarea, select, a[href]';

/** Move focus to the first control in `panel`, or to the panel itself when it has none (it needs tabIndex -1). */
export function focusFirst(panel: HTMLElement | null) {
  if (!panel) return;
  const target = panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
  target.focus({ preventScroll: false });
}

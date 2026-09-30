import { useEffect, useRef } from "react";

/**
 * Quiz keyboard: 1-4 pick an option, Enter checks the answer (or goes to the
 * next question once the answer is revealed).
 *
 * Keys typed into a text field are left alone, and so is Enter on a focused
 * button or link: the browser already clicks it, and handling it here too
 * would act twice. Modifier chords (Cmd+1 switches browser tabs) pass through.
 */
export function useQuizKeys(handlers: { onNumber: (n: number) => void; onEnter: () => void }) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("textarea, select, [contenteditable='true'], [role='dialog']")) return;
      if (target instanceof HTMLInputElement && target.type !== "radio") return;

      if (/^[1-4]$/.test(e.key)) {
        e.preventDefault();
        latest.current.onNumber(Number(e.key) - 1);
      } else if (e.key === "Enter") {
        if (target?.closest("button, a[href]")) return;
        e.preventDefault();
        if (!e.repeat) latest.current.onEnter();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

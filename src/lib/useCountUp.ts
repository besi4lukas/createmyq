import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { COUNT_UP_MS, countUpValue } from "./motion";

/**
 * Count from 0 up to `target` (the results score, STM-26). Under reduced
 * motion it shows the final number straight away. Always ends on `target`.
 */
export function useCountUp(target: number, duration = COUNT_UP_MS): number {
  const reduce = useReducedMotion();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (reduce) return;
    let frame = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const next = countUpValue(target, now - began, duration);
      setValue(next);
      if (next !== target || now - began < duration) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduce]);

  return reduce ? target : value;
}

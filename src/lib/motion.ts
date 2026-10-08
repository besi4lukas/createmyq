/**
 * Motion (STM-26): the timings from the design's motion table, in one place.
 * Transform and opacity only. Colours, sizes and layout never animate.
 *
 * Reduced motion: App wraps everything in <MotionConfig reducedMotion="user">,
 * and every component here also checks useReducedMotion() and skips the
 * animation entirely (`initial={false}`), so state changes are instant, as the
 * design asks. The CSS guard in index.css covers CSS transitions.
 */
import type { Transition, Variants } from "motion/react";

type Bezier = [number, number, number, number];

const EASE_SOFT: Bezier = [0.2, 0.8, 0.2, 1];
const EASE_NEXT: Bezier = [0.2, 0.9, 0.2, 1];
/** Spring-like overshoot: the reveal panel and the correct-option pop. */
const EASE_SPRING: Bezier = [0.34, 1.56, 0.64, 1];

/** Next question: slides in from the right. */
export const questionEnter = {
  initial: { opacity: 0, x: 56, scale: 0.98 },
  animate: { opacity: 1, x: 0, scale: 1 },
  transition: { duration: 0.52, ease: EASE_NEXT } satisfies Transition,
};

/** Practice reveal panel: rises in with a little overshoot. */
export const revealEnter = {
  initial: { opacity: 0, y: 22, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: {
    // The overshoot is for movement; opacity just fades.
    default: { duration: 0.56, ease: EASE_SPRING },
    opacity: { duration: 0.3, ease: "easeOut" },
  } satisfies Transition,
};

/** Revealed options: the right one pops, a wrong pick shakes. Keyed by state, so each plays once. */
export const optionVariants: Variants = {
  right: { scale: [1, 1.04, 1], transition: { duration: 0.46, ease: EASE_SPRING } },
  wrong: { x: [0, -9, 8, -5, 2, 0], transition: { duration: 0.42, ease: "linear" } },
};

/** Inline setup panel on Home's category cards: fades down into place. Height never animates; closing is instant. */
export const panelEnter = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.32, ease: EASE_SOFT } satisfies Transition,
};

/** Results count-up: 0 → pct. */
export const COUNT_UP_MS = 1100;

/** Ease-out cubic. */
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * The number shown `elapsed` ms into the count-up to `target`. Whole numbers,
 * never past the target, and exactly the target at (and after) the end.
 */
export function countUpValue(target: number, elapsed: number, duration = COUNT_UP_MS): number {
  if (duration <= 0 || elapsed >= duration) return target;
  const t = Math.max(0, elapsed) / duration;
  return Math.min(target, Math.round(target * easeOutCubic(t)));
}

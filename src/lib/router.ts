/**
 * A tiny router over the History API. Four screens don't need a routing library,
 * but they do need real URLs: a refresh mid-quiz must land back on the quiz, and
 * a phone's back button must go back a screen, not leave the app.
 *
 *   /                  home
 *   /setup/<category>  quiz setup
 *   /quiz              the quiz in progress
 *   /results           the result of the quiz just finished (in memory only)
 *
 * Clerk's sign-in uses the hash (#/...), which this router ignores.
 */
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "setup"; category: string }
  | { name: "quiz" }
  | { name: "results" };

const CHANGE = "createmyq:navigate";

function parse(pathname: string): Route {
  if (pathname === "/quiz") return { name: "quiz" };
  if (pathname === "/results") return { name: "results" };
  const setup = /^\/setup\/([a-z0-9-]{1,64})$/.exec(pathname);
  if (setup) return { name: "setup", category: setup[1]! };
  return { name: "home" };
}

export function pathOf(route: Route): string {
  switch (route.name) {
    case "home":
      return "/";
    case "setup":
      return `/setup/${route.category}`;
    case "quiz":
      return "/quiz";
    case "results":
      return "/results";
  }
}

export function navigate(route: Route, { replace = false } = {}) {
  const path = pathOf(route);
  if (path !== window.location.pathname) {
    if (replace) window.history.replaceState(null, "", path);
    else window.history.pushState(null, "", path);
  }
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

const getPath = () => window.location.pathname;

/** The current route. Re-renders on navigate() and on back/forward. */
export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, getPath);
  return parse(path);
}

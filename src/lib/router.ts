/**
 * A tiny router over the History API. Four screens don't need a routing library,
 * but they do need real URLs: a refresh mid-quiz must land back on the quiz, and
 * a phone's back button must go back a screen, not leave the app.
 *
 *   /                  home
 *   /setup/<category>  quiz setup
 *   /quiz              the quiz in progress
 *   /results           the result of the quiz just finished (in memory only)
 *   /add               bring your own material: a PDF, an article or a YouTube link
 *   /sources/<id>      one of your sources and its status (safe to refresh or come back to)
 *   /sources/<id>/setup  quiz setup for one of your sources
 *
 * Clerk's sign-in uses the hash (#/...), which this router ignores.
 */
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "setup"; category: string }
  | { name: "quiz" }
  | { name: "results" }
  | { name: "add" }
  | { name: "source"; id: string }
  | { name: "source-setup"; id: string };

const CHANGE = "createmyq:navigate";

export function parse(pathname: string): Route {
  if (pathname === "/quiz") return { name: "quiz" };
  if (pathname === "/results") return { name: "results" };
  if (pathname === "/add") return { name: "add" };
  const sourceSetup = /^\/sources\/([0-9a-f-]{36})\/setup$/i.exec(pathname);
  if (sourceSetup) return { name: "source-setup", id: sourceSetup[1]!.toLowerCase() };
  const source = /^\/sources\/([0-9a-f-]{36})$/i.exec(pathname);
  if (source) return { name: "source", id: source[1]!.toLowerCase() };
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
    case "add":
      return "/add";
    case "source":
      return `/sources/${route.id}`;
    case "source-setup":
      return `/sources/${route.id}/setup`;
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

/** Props for an in-app link: a real href (open in new tab, copy link) and client-side navigation on click. */
export function linkTo(route: Route) {
  return {
    href: pathOf(route),
    onClick: (e: { preventDefault: () => void }) => {
      e.preventDefault();
      navigate(route);
    },
  };
}

const getPath = () => window.location.pathname;

/** The current route. Re-renders on navigate() and on back/forward. */
export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, getPath);
  return parse(path);
}

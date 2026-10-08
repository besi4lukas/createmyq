/**
 * STM-27: Sentry in the browser. Loaded with a dynamic import from main.tsx
 * only when VITE_SENTRY_DSN was set at build time, so a build without it ships
 * none of the SDK. Errors only: no tracing, no replay, no breadcrumbs, and
 * every event goes through scrubEvent.
 */
import * as Sentry from "@sentry/react";
import type { ErrorInfo } from "react";
import { scrubEvent } from "./sentry-scrub";

export function initSentry(dsn: string): void {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE === "production" ? "production" : "development",
    sampleRate: 1,
    // SDK v11 collects headers, cookies, query strings and user info by default: all off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubEvent(event),
  });
}

/** For createRoot's onUncaughtError / onCaughtError / onRecoverableError. */
export function captureReactError(error: unknown, info: ErrorInfo): void {
  Sentry.captureReactException(error, info);
}

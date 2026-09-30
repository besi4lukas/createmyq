/** Thrown for any non-2xx API response. `message` is safe to show the user. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    /** The whole JSON body, for errors that carry data (e.g. 409 quiz_in_progress + the quiz). */
    public data?: unknown,
  ) {
    super(message);
  }
}

let getToken: () => Promise<string | null> = async () => null;
/** The app registers Clerk's `getToken` so every call carries the session token. */
export function setTokenGetter(fn: () => Promise<string | null>) {
  getToken = fn;
}

let onUnauthorized: () => void = () => {};
/** The app registers what to do on a 401 (back to the sign-in screen). */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

let onNotInvited: () => void = () => {};
/** The app registers what to do on 403 `not_invited` (signed in with Clerk, not on the list). */
export function setNotInvitedHandler(fn: () => void) {
  onNotInvited = fn;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    const token = await getToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";
    res = await fetch(`/api${path}`, {
      method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "Could not reach CreateMyQ. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (res.status === 401) onUnauthorized();
  if (res.status === 403 && data.code === "not_invited") onNotInvited();
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? "Something went wrong. Please try again.", data.code, data);
  }
  return data as T;
}

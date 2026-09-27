/** Thrown for any non-2xx API response. `message` is safe to show the user. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
/** The app registers where to go on a 401 (the sign-in screen). */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
      headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "Could not reach CreateMyQ. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.error ?? "Something went wrong. Please try again.");
  return data as T;
}

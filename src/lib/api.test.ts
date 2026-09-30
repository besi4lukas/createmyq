import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setNotInvitedHandler, setTokenGetter, setUnauthorizedHandler } from "./api";

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected an ApiError");
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setTokenGetter(async () => "tok");
  setUnauthorizedHandler(() => {});
  setNotInvitedHandler(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("api()", () => {
  it("GETs with the bearer token and returns the JSON", async () => {
    fetchMock.mockResolvedValue(json(200, { quiz: null }));
    await expect(api("/session")).resolves.toEqual({ quiz: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/session");
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer tok" }, body: undefined, credentials: "same-origin" });
  });

  it("POSTs a JSON body by default, and sends no Authorization without a token", async () => {
    setTokenGetter(async () => null);
    fetchMock.mockResolvedValue(json(201, { ok: 1 }));
    await api("/session", { body: { a: 1 } });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("maps a network failure to status 0 with a friendly message", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await caught(api("/me"));
    expect(err.status).toBe(0);
    expect(err.message).toBe("Could not reach CreateMyQ. Check your connection and try again.");
  });

  it("keeps the server's message, code and body on an error", async () => {
    fetchMock.mockResolvedValue(json(409, { error: "In progress", code: "quiz_in_progress", quiz: { quizId: "q" } }));
    const err = await caught(api("/session", { body: {} }));
    expect(err).toMatchObject({ status: 409, message: "In progress", code: "quiz_in_progress" });
    expect(err.data).toEqual({ error: "In progress", code: "quiz_in_progress", quiz: { quizId: "q" } });
  });

  it("falls back to a generic message for a non-JSON error", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 502 }));
    const err = await caught(api("/me"));
    expect(err).toMatchObject({ status: 502, message: "Something went wrong. Please try again.", code: undefined });
  });

  it("calls the 401 and not_invited handlers", async () => {
    const onUnauthorized = vi.fn();
    const onNotInvited = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setNotInvitedHandler(onNotInvited);
    fetchMock.mockResolvedValueOnce(json(401, { error: "Please sign in." }));
    expect((await caught(api("/me"))).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json(403, { error: "Blocked", code: "not_invited" }));
    expect((await caught(api("/me"))).code).toBe("not_invited");
    expect(onNotInvited).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json(403, { error: "Request blocked." }));
    await caught(api("/me"));
    expect(onNotInvited).toHaveBeenCalledTimes(1);
  });
});

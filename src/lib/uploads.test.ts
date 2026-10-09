import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setTokenGetter } from "./api";
import { PUT_FAILED, uploadPdf } from "./uploads";

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ticket = { sourceId: "s1", uploadUrl: "https://r2.example/put?sig", headers: { "Content-Type": "application/pdf" }, expiresAt: "x" };
const file = new File([new Uint8Array(10)], "paper.pdf", { type: "application/pdf" });
const paths = () => fetchMock.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setTokenGetter(async () => "tok");
});
afterEach(() => vi.unstubAllGlobals());

describe("uploadPdf", () => {
  it("signs, PUTs the file with the signed headers, then completes", async () => {
    const source = { id: "s1", title: "paper", status: "uploaded", bankSourceId: "s1", createdAt: "t" };
    fetchMock
      .mockResolvedValueOnce(json(200, ticket))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json(200, { source }));
    await expect(uploadPdf(file)).resolves.toEqual(source);
    expect(paths()).toEqual(["/api/uploads", ticket.uploadUrl, "/api/uploads/complete"]);
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "PUT", headers: ticket.headers, body: file });
  });

  it.each([
    ["R2 refuses the PUT (403)", () => fetchMock.mockResolvedValueOnce(new Response("<Error/>", { status: 403 }))],
    ["the PUT is blocked (CORS / network)", () => fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))],
  ])("%s: says the file did not arrive and never calls complete", async (_, failPut) => {
    fetchMock.mockResolvedValueOnce(json(200, ticket));
    failPut();
    const err = await uploadPdf(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: PUT_FAILED, code: "upload_put_failed" });
    expect(paths()).toEqual(["/api/uploads", ticket.uploadUrl]);
  });
});

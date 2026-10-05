import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  checkUploadRequest,
  checkUploadedObject,
  completeUploadBody,
  createUploadBody,
  titleFromFilename,
  uploadExpiresAt,
  uploadKey,
} from "./upload-rules";

const pdf = { filename: "Designing Data-Intensive Apps.pdf", size: 1024, contentType: "application/pdf" };

describe("checkUploadRequest", () => {
  it("accepts a PDF up to exactly 20 MB", () => {
    expect(checkUploadRequest(pdf)).toEqual({ ok: true });
    expect(checkUploadRequest({ ...pdf, size: MAX_UPLOAD_BYTES })).toEqual({ ok: true });
    expect(checkUploadRequest({ ...pdf, filename: "NOTES.PDF" })).toEqual({ ok: true });
  });

  it("rejects anything over 20 MB with a friendly message", () => {
    const r = checkUploadRequest({ ...pdf, size: MAX_UPLOAD_BYTES + 1 });
    expect(r).toEqual({ ok: false, code: "too_large", error: "This file is over 20 MB. Try a smaller PDF." });
  });

  it("rejects a non-PDF by type or by name", () => {
    expect(checkUploadRequest({ ...pdf, contentType: "image/png" })).toMatchObject({ ok: false, code: "not_pdf" });
    expect(checkUploadRequest({ ...pdf, filename: "notes.docx" })).toMatchObject({ ok: false, code: "not_pdf" });
  });

  it("rejects an empty file", () => {
    expect(checkUploadRequest({ ...pdf, size: 0 })).toMatchObject({ ok: false, code: "empty" });
  });
});

describe("checkUploadedObject", () => {
  it("re-checks what R2 stored", () => {
    expect(checkUploadedObject({ size: 10, contentType: "application/pdf" })).toEqual({ ok: true });
    expect(checkUploadedObject({ size: MAX_UPLOAD_BYTES + 1, contentType: "application/pdf" })).toMatchObject({
      code: "too_large",
    });
    expect(checkUploadedObject({ size: 10, contentType: undefined })).toMatchObject({ code: "not_pdf" });
  });
});

describe("schemas", () => {
  it("parse the request bodies strictly", () => {
    expect(createUploadBody.safeParse(pdf).success).toBe(true);
    expect(createUploadBody.safeParse({ ...pdf, extra: 1 }).success).toBe(false);
    expect(createUploadBody.safeParse({ ...pdf, size: 1.5 }).success).toBe(false);
    expect(completeUploadBody.safeParse({ sourceId: "not-a-uuid", filename: "a.pdf" }).success).toBe(false);
    expect(
      completeUploadBody.safeParse({ sourceId: "0b8e1c1e-8f7a-4d3b-9a63-3c3c7e7b5a11", filename: "a.pdf" }).success,
    ).toBe(true);
  });
});

describe("keys, titles and expiry", () => {
  it("scopes the key to the user", () => {
    expect(uploadKey("u1", "s1")).toBe("uploads/u1/s1.pdf");
  });
  it("titles from the filename", () => {
    expect(titleFromFilename("  Raft paper.PDF ")).toBe("Raft paper");
    expect(titleFromFilename(".pdf")).toBe("Untitled PDF");
  });
  it("expires in five minutes", () => {
    expect(uploadExpiresAt(new Date("2026-10-05T18:00:00Z")).toISOString()).toBe("2026-10-05T18:05:00.000Z");
  });
});

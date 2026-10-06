/**
 * STM-14: the fingerprint that goes in `sources.content_hash` (unique: that
 * constraint is the cache, STM-16).
 *
 * It is a SHA-256 over a canonical form of the normalised text: lowercased and
 * with every run of whitespace (line breaks included) collapsed to one space.
 * So the same document hashes the same however its lines happen to wrap, but
 * any change to the words changes the hash. The source kind is not part of it:
 * the same text is the same bank whether it came as a PDF or a web page.
 *
 * Format: "v1:" + 64 lowercase hex chars. The version names the normalisation +
 * canonicalisation rules; bump it whenever either changes, so old and new
 * hashes can never be confused.
 */
import { normaliseText } from "./normalise";

export const FINGERPRINT_VERSION = "v1";

export function canonicalForm(text: string): string {
  return normaliseText(text).toLowerCase().replace(/\s+/g, " ").trim();
}

export async function fingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalForm(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${FINGERPRINT_VERSION}:${hex}`;
}

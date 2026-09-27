/** 32 random bytes as base64url. Used for magic-link tokens and session cookies. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * SHA-256 hex of a token. Only this hash is stored, so a leaked database row
 * can't be replayed. A plain hash (no salt) is enough: the input is 256 bits of
 * randomness, not a guessable password.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * STM-14: text normalisation. Pure and deterministic: the fingerprint is taken
 * over this output, so the same source must always normalise to the same text.
 * Changing a rule here changes every fingerprint; bump FINGERPRINT_VERSION in
 * fingerprint.ts when you do.
 *
 * Rules, in order:
 *   1. Unicode NFC, and the Latin ligatures PDFs love (ﬁ ﬂ ﬀ ﬃ ﬄ ﬅ ﬆ) spelled out.
 *   2. Line endings → \n. Form feeds, vertical tabs, U+2028/2029 → \n.
 *   3. Invisible characters removed: soft hyphen, zero-width space/joiners,
 *      BOM, and C0/C1 control characters other than \n.
 *   4. Every other kind of space (tab, NBSP, thin space, …) → a plain space.
 *   5. De-hyphenation: "imple-\nmentation" → "implementation" when a lowercase
 *      letter, a hyphen, a line break and a lowercase letter meet. (A real
 *      compound split across lines, "client-\nside", also joins. Accepted.)
 *   6. Per line: runs of spaces → one space, trimmed.
 *   7. More than one blank line in a row → one blank line; trimmed overall.
 */

const LIGATURES: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
};

export function normaliseText(raw: string): string {
  return (
    raw
      .normalize("NFC")
      .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c)
      .replace(/\r\n?/g, "\n")
      .replace(/[\f\v\u2028\u2029\u0085]/g, "\n")
      // Soft hyphen, zero-width space/non-joiner/joiner, word joiner, BOM.
      .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g, "")
      // Any horizontal whitespace that is not a plain space.
      .replace(/[^\S\n ]/g, " ")
      .replace(/(\p{Ll})-[ ]*\n[ ]*(?=\p{Ll})/gu, "$1")
      .split("\n")
      .map((line) => line.replace(/ {2,}/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Letters only, the measure of "is there any text here at all". */
export function countLetters(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

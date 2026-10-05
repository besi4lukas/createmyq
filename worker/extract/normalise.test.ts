import { describe, expect, it } from "vitest";
import { canonicalForm, fingerprint, FINGERPRINT_VERSION } from "./fingerprint";
import { countLetters, normaliseText } from "./normalise";

describe("normaliseText", () => {
  it("joins words hyphenated across a line break, but not real hyphens", () => {
    expect(normaliseText("an imple-\nmentation detail")).toBe("an implementation detail");
    expect(normaliseText("an imple- \n  mentation")).toBe("an implementation");
    expect(normaliseText("read-only\nmemory")).toBe("read-only\nmemory");
    expect(normaliseText("Java-\nScript")).toBe("Java-\nScript"); // capital after the break: keep
    expect(normaliseText("step 1 -\n2")).toBe("step 1 -\n2");
  });

  it("applies NFC and spells out ligatures", () => {
    const decomposed = "cafe\u0301";
    expect(normaliseText(decomposed)).toBe("caf\u00E9");
    expect(normaliseText("\uFB01le \uFB02ow e\uFB00ect")).toBe("file flow effect");
  });

  it("removes invisible characters and unifies spaces and line endings", () => {
    expect(normaliseText("zero\u200Bwidth soft\u00ADhyphen\uFEFF")).toBe("zerowidth softhyphen");
    expect(normaliseText("a\u00A0b\tc\u2009d")).toBe("a b c d");
    expect(normaliseText("one\r\ntwo\rthree\fFour")).toBe("one\ntwo\nthree\nFour");
    expect(normaliseText("bell\u0007 nul\u0000")).toBe("bell nul");
  });

  it("collapses spaces per line and blank lines to one, and trims", () => {
    expect(normaliseText("  lots    of   space  \n\n\n\n next  \n")).toBe("lots of space\n\nnext");
    expect(normaliseText("   \n\t\n  ")).toBe("");
  });

  it("is idempotent", () => {
    const samples = [
      "  An imple-\nmentation\r\n\r\n\r\nof \uFB01les\u00A0and\u200B things  ",
      "x -\n y\n\n\n- list\n-\nitem",
      ...Array.from({ length: 300 }, (_, i) => randomText(i + 1)),
    ];
    for (const s of samples) {
      const once = normaliseText(s);
      expect(normaliseText(once)).toBe(once);
    }
  });
});

describe("countLetters", () => {
  it("counts letters in any script, not digits or punctuation", () => {
    expect(countLetters("abc 123 ... \u00E9 \u0436 \u5B57")).toBe(6);
  });
});

describe("fingerprint", () => {
  it("is stable: a fixed input always gives this hash", async () => {
    // If this changes, every stored content_hash is invalidated: bump FINGERPRINT_VERSION.
    expect(await fingerprint("Hello, world")).toBe(
      "v1:09ca7e4eaa6e8ae9c7d261167129184883644d07dfba7cbfbc4c8a2e08360d5b",
    );
    expect(FINGERPRINT_VERSION).toBe("v1");
  });

  it("ignores line wrapping, case, spacing and invisible characters", async () => {
    const a = await fingerprint("The Event Loop\nexplained in\ndetail.");
    expect(await fingerprint("the event loop explained   in detail.")).toBe(a);
    expect(await fingerprint("  The Event\u00A0Loop\r\n\r\nexplained in detail.\u200B ")).toBe(a);
    expect(await fingerprint("The Event Loop ex-\nplained in detail.")).toBe(a); // de-hyphenated first
  });

  it("changes when the words change", async () => {
    expect(await fingerprint("The event loop")).not.toBe(await fingerprint("The event loops"));
  });

  it("matches on normalised and raw input alike", async () => {
    const raw = "An imple-\nmentation of \uFB01les";
    expect(await fingerprint(raw)).toBe(await fingerprint(normaliseText(raw)));
    expect(canonicalForm(raw)).toBe("an implementation of files");
  });
});

/** Deterministic junk with the characters the rules care about. */
function randomText(seed: number): string {
  const alphabet = ["a", "B", "-", "\n", " ", "\t", "\r", "\u00A0", "\u200B", "\uFB01", "e\u0301", "1", ".", "\u00AD"];
  let x = seed * 2654435761;
  let out = "";
  for (let i = 0; i < 400; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

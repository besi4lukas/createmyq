import { describe, expect, it } from "vitest";
import { UPLOAD_PANEL, catPanel, closePanel, openPanel, srcPanel } from "./panel";

describe("Home: one panel open across category cards, the upload card and source rows", () => {
  it("opening any panel closes the open one", () => {
    let open = openPanel(null, catPanel("system-design"));
    expect(open).toBe("cat:system-design");
    open = openPanel(open, UPLOAD_PANEL);
    expect(open).toBe("upload");
    open = openPanel(open, srcPanel("abc"));
    expect(open).toBe("src:abc");
    open = openPanel(open, catPanel("system-design"));
    expect(open).toBe("cat:system-design");
  });

  it("closing closes only the panel named, so a late close never shuts a newer one", () => {
    expect(closePanel("upload", UPLOAD_PANEL)).toBeNull();
    expect(closePanel(srcPanel("a"), srcPanel("a"))).toBeNull();
    expect(closePanel(srcPanel("b"), srcPanel("a"))).toBe("src:b");
    expect(closePanel(catPanel("x"), UPLOAD_PANEL)).toBe("cat:x");
    expect(closePanel(null, UPLOAD_PANEL)).toBeNull();
  });
});

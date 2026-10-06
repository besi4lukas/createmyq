import { describe, expect, it } from "vitest";
import { extractArticle, htmlToArticle, LINK_IS_PDF, NO_ARTICLE_TEXT } from "./article";

const para = (topic: string) =>
  `<p>${topic} is one of the ideas every engineer meets sooner or later. It shows up when a service has to stay
  correct while machines fail, networks split and clocks drift, and the trade-offs are rarely obvious at first
  sight. This paragraph exists so that the article is long enough to look like a real one.</p>`;

const page = `<!doctype html><html><head><title>Consensus, explained | Some Blog</title>
<script>window.tracking = 1</script><style>p{color:red}</style></head>
<body>
  <header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/subscribe">Subscribe</a></nav></header>
  <main><article>
    <h1>Consensus, explained</h1>
    ${para("Consensus")}
    <h2>Why Raft</h2>
    ${para("Raft")}
    <ul><li>Leader election</li><li>Log replication</li></ul>
    <pre><code>if (term &gt; currentTerm) {
  becomeFollower(term);
}</code></pre>
    ${para("Paxos")}
  </article></main>
  <aside>Related posts: 10 tips for CSS</aside>
  <footer>&copy; 2026 Some Blog. All rights reserved. Cookie settings.</footer>
</body></html>`;

describe("htmlToArticle", () => {
  it("keeps the article, its headings, lists and code, and drops the chrome", () => {
    const { title, text } = htmlToArticle(page);
    expect(title).toMatch(/Consensus, explained/);
    expect(text).toContain("## Why Raft\n\nRaft is one of the ideas");
    expect(text).toContain("- Leader election\n- Log replication");
    expect(text).toContain("if (term > currentTerm) {\nbecomeFollower(term);\n}");
    for (const junk of ["window.tracking", "color:red", "Subscribe", "All rights reserved", "10 tips for CSS"]) {
      expect(text).not.toContain(junk);
    }
    expect(text).not.toMatch(/\n{3,}| {2,}/);
  });

  it("falls back to the body when Readability finds nothing", () => {
    const bare = `<html><body><nav>Menu</nav><div>${"Plain words without much markup at all. ".repeat(20)}</div></body></html>`;
    const { text } = htmlToArticle(bare);
    expect(text.startsWith("Plain words without much markup")).toBe(true);
    expect(text).not.toContain("Menu");
  });
});

describe("extractArticle", () => {
  const serve = (body: string, contentType: string) =>
    (async () => new Response(body, { headers: { "content-type": contentType } })) as unknown as typeof fetch;

  it("returns normalised text with a fingerprint", async () => {
    const r = await extractArticle("https://blog.example/consensus", serve(page, "text/html; charset=utf-8"));
    if (!r.ok) throw new Error(r.message);
    expect(r).toMatchObject({ kind: "article", url: "https://blog.example/consensus", spans: [] });
    expect(r.fingerprint).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("refuses PDFs, images and near-empty pages", async () => {
    expect(await extractArticle("https://x.example/a.pdf", serve("%PDF-1.4", "application/pdf"))).toMatchObject({
      ok: false,
      message: LINK_IS_PDF,
    });
    expect(await extractArticle("https://x.example/a.png", serve("png", "image/png"))).toMatchObject({
      ok: false,
      code: "not_html",
    });
    expect(
      await extractArticle("https://x.example/", serve("<html><body><p>Just a login form.</p></body></html>", "text/html")),
    ).toEqual({ ok: false, code: "no_article_text", message: NO_ARTICLE_TEXT, retryable: false });
  });
});

/**
 * STM-14: an article URL → its readable text.
 *
 * Fetch (safe-fetch.ts: http(s) only, no private hosts, 15 s, 5 MB), parse the
 * HTML with linkedom (a small DOM that runs on Workers), let Mozilla's
 * Readability (Firefox Reader View) pick the main content, then render that
 * content as plain text with paragraph breaks and markdown-style headings
 * ("## Title"), which STM-17 can use for heading paths. If Readability finds
 * nothing, fall back to the page body minus nav/header/footer/aside.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { normaliseText, countLetters } from "./normalise";
import { fingerprint } from "./fingerprint";
import { fail, type ExtractResult } from "./result";
import { decodeBody, safeFetch } from "./safe-fetch";

/** The worker has no DOM lib; linkedom's document is what Readability gets. */
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

export const ARTICLE_TIMEOUT_MS = 15_000;
export const MAX_ARTICLE_BYTES = 5 * 1024 * 1024;
/** Fewer letters than this and there is no article to speak of. */
export const MIN_ARTICLE_LETTERS = 300;

export const NOT_HTML = "That link isn't a web page I can read.";
export const LINK_IS_PDF = "That link is a PDF. Download it and upload the file instead.";
export const NO_ARTICLE_TEXT = "I couldn't find an article on that page.";

const USER_AGENT = "Mozilla/5.0 (compatible; CreateMyQ/1.0; +https://createmyq.workers.dev)";

export async function extractArticle(url: string, fetchImpl?: typeof fetch): Promise<ExtractResult> {
  const res = await safeFetch(url, {
    timeoutMs: ARTICLE_TIMEOUT_MS,
    maxBytes: MAX_ARTICLE_BYTES,
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5" },
    fetchImpl,
  });
  if (!res.ok) return res;

  const type = res.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/pdf") return fail("not_html", LINK_IS_PDF);
  const isHtml = type === "text/html" || type === "application/xhtml+xml" || type === "";
  if (!isHtml && type !== "text/plain") return fail("not_html", NOT_HTML, { detail: type });

  const body = decodeBody(res.bytes, res.contentType);
  const page = type === "text/plain" ? { title: null, text: normaliseText(body) } : htmlToArticle(body);
  if (countLetters(page.text) < MIN_ARTICLE_LETTERS) return fail("no_article_text", NO_ARTICLE_TEXT);

  return {
    ok: true,
    kind: "article",
    text: page.text,
    fingerprint: await fingerprint(page.text),
    title: page.title,
    url: res.url,
    spans: [],
    meta: { bytes: res.bytes.byteLength, contentType: type },
  };
}

/** Pure: an HTML page → its title and normalised main text. */
export function htmlToArticle(html: string): { title: string | null; text: string } {
  const { document } = parseHTML(html);
  const pageTitle = clean(document.querySelector("title")?.textContent);

  const readable = readabilityParse(document as unknown as ReadabilityDocument);
  if (readable?.content) {
    const text = normaliseText(renderText(parseHTML(`<html><body>${readable.content}</body></html>`).document.body));
    if (countLetters(text) >= MIN_ARTICLE_LETTERS) return { title: clean(readable.title) ?? pageTitle, text };
  }

  // Fallback: the whole body without the obvious chrome.
  const fresh = parseHTML(html).document;
  for (const el of fresh.querySelectorAll("nav, header, footer, aside, form, [role=navigation], [aria-hidden=true]")) {
    el.remove();
  }
  return { title: pageTitle, text: normaliseText(renderText(fresh.body)) };
}

function readabilityParse(document: ReadabilityDocument): ReturnType<Readability["parse"]> {
  try {
    // Readability mutates the document; it's ours to throw away.
    return new Readability(document, { charThreshold: 200 }).parse();
  } catch {
    return null;
  }
}

function clean(s:string | null | undefined): string | null {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 300) : null;
}

const SKIP = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
  "nav", "button", "select", "input", "textarea", "form", "img", "video", "audio", "picture",
]);
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "blockquote", "ul", "ol", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "figure", "figcaption", "details", "summary", "hr", "address", "header", "footer", "aside",
]);

type DomNode = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<DomNode> };

/** DOM → plain text: blocks become paragraphs, headings "## …", list items "- …", <pre> keeps its lines. */
export function renderText(root: DomNode | null | undefined): string {
  if (!root) return "";
  const out: string[] = [];
  const walk = (node: DomNode, inPre: boolean): void => {
    if (node.nodeType === 3) {
      const t = node.textContent ?? "";
      out.push(inPre ? t : t.replace(/\s+/g, " "));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.nodeName.toLowerCase();
    if (SKIP.has(tag)) return;
    const children = () => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child) walk(child, inPre || tag === "pre");
      }
    };
    const heading = tag.match(/^h([1-6])$/);
    if (heading) {
      const level = Number(heading[1]);
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) out.push(`\n\n${"#".repeat(level)} ${text}\n\n`);
    } else if (tag === "br") {
      out.push("\n");
    } else if (tag === "li") {
      out.push("\n- ");
      children();
    } else if (tag === "pre") {
      out.push("\n\n");
      children();
      out.push("\n\n");
    } else if (tag === "td" || tag === "th") {
      out.push(" ");
      children();
      out.push(" ");
    } else if (BLOCK.has(tag)) {
      out.push("\n\n");
      children();
      out.push("\n\n");
    } else {
      children();
    }
  };
  walk(root, false);
  return out.join("");
}

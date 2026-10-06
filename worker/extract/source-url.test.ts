import { describe, expect, it } from "vitest";
import { BAD_URL, BLOCKED_URL, isPrivateHost, parseSourceUrl } from "./source-url";

describe("parseSourceUrl: YouTube", () => {
  const id = "8aGhZQkoFbQ";
  const watch = `https://www.youtube.com/watch?v=${id}`;

  it.each([
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `http://m.youtube.com/watch?feature=share&v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc&t=10`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?start=3`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `  https://YOUTU.BE/${id}  `,
  ])("%s", (url) => {
    expect(parseSourceUrl(url)).toEqual({ kind: "youtube", videoId: id, url: watch });
  });

  it("refuses YouTube links that aren't one video", () => {
    for (const url of [
      "https://www.youtube.com/@fireship",
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/watch?v=short",
      "https://youtu.be/",
    ]) {
      expect(parseSourceUrl(url)).toMatchObject({ ok: false, code: "bad_url" });
    }
  });
});

describe("parseSourceUrl: articles", () => {
  it("accepts public http(s) pages and drops the fragment", () => {
    expect(parseSourceUrl("https://martinfowler.com/articles/microservices.html#Componentization")).toEqual({
      kind: "article",
      url: "https://martinfowler.com/articles/microservices.html",
    });
    expect(parseSourceUrl("http://example.org:80/a?b=c")).toEqual({ kind: "article", url: "http://example.org/a?b=c" });
  });

  it("refuses things that aren't web links", () => {
    for (const url of ["", "not a url", "ftp://example.org/x", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"]) {
      expect(parseSourceUrl(url)).toEqual({ ok: false, code: "bad_url", message: BAD_URL, retryable: false });
    }
  });

  it("refuses local and private targets", () => {
    for (const url of [
      "http://localhost:8787/api",
      "http://localhost/",
      "http://127.0.0.1/",
      "http://2130706433/", // 127.0.0.1 as a number
      "http://0x7f.0.0.1/",
      "http://10.0.0.5/",
      "http://172.16.3.4/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://intranet/",
      "http://printer.local/",
      "http://db.internal/",
      "https://example.org:8443/",
      "https://user:pass@example.org/",
    ]) {
      expect(parseSourceUrl(url), url).toMatchObject({ ok: false, code: "blocked_url", message: BLOCKED_URL });
    }
  });
});

describe("isPrivateHost", () => {
  it("lets public names and addresses through", () => {
    for (const host of ["example.org", "martinfowler.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "[2606:4700::1111]"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

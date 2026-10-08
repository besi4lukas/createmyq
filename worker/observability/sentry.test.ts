import { CloudflareClient, createTransport, getDefaultIntegrations, type CloudflareOptions } from "@sentry/cloudflare";
import { Scope, createStackParser } from "@sentry/core";
import { describe, expect, it } from "vitest";
import { scrubEvent, scrubText, sentryOptions } from "./sentry";

const DSN = "https://publickey@o0.ingest.sentry.io/0";

describe("scrubText", () => {
  it("masks emails, bearer tokens, JWTs, query strings and connection strings", () => {
    expect(scrubText("not_invited: Friend.Name+x@example.co.uk")).toBe("not_invited: [email]");
    expect(scrubText("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [redacted]");
    expect(scrubText("token eyJhbGciOi.eyJzdWIiOi.c2ln")).toBe("token [jwt]");
    expect(scrubText("GET https://example.com/a/b?email=x&q=1 failed")).toBe("GET https://example.com/a/b?[redacted] failed");
    expect(scrubText("connect postgres://user:pw@host/db")).toBe("connect postgres://[redacted]");
    expect(scrubText("source failed: too_thin")).toBe("source failed: too_thin");
  });
});

describe("scrubEvent", () => {
  it("drops user, breadcrumbs, extra, headers, cookies, body and query; masks messages", () => {
    const event = scrubEvent({
      type: undefined,
      message: "for a@b.io",
      user: { email: "a@b.io", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "fetch https://x.test/?q=secret" }],
      extra: { body: "question text" },
      server_name: "host",
      request: {
        method: "POST",
        url: "https://app.test/api/quiz?category=x#frag",
        headers: { authorization: "Bearer t" },
        cookies: { __session: "s" },
        data: { answer: 1 },
        query_string: "category=x",
      },
      exception: { values: [{ type: "Error", value: "invite missing for a@b.io" }] },
    });
    expect(event).toEqual({
      type: undefined,
      message: "for [email]",
      request: { method: "POST", url: "https://app.test/api/quiz" },
      exception: { values: [{ type: "Error", value: "invite missing for [email]" }] },
    });
  });
});

/** A client like the one withSentry builds, with a transport that records instead of sending. */
function clientFor(env: { SENTRY_DSN?: string }) {
  const sent: string[] = [];
  const options = sentryOptions(env);
  const client = new CloudflareClient({
    ...(options as CloudflareOptions & { dsn?: string }),
    integrations: getDefaultIntegrations(options),
    stackParser: createStackParser(),
    transport: (o) =>
      createTransport(o, async (request) => {
        sent.push(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      }),
  });
  client.init();
  return { client, sent };
}

describe("sentryOptions", () => {
  it("is disabled without a DSN: nothing is sent", async () => {
    const { client, sent } = clientFor({});
    const scope = new Scope();
    scope.setClient(client);
    scope.captureException(new Error("boom for a@b.io"));
    await client.flush(500);
    expect(sent).toEqual([]);
    expect(sentryOptions({ SENTRY_DSN: "  " }).enabled).toBe(false);
  });

  it("with a DSN, sends the error scrubbed and without breadcrumbs or request headers", async () => {
    const { client, sent } = clientFor({ SENTRY_DSN: DSN });
    const scope = new Scope();
    scope.setClient(client);
    scope.setUser({ email: "a@b.io" });
    scope.addBreadcrumb({ message: "console a@b.io" });
    scope.setSDKProcessingMetadata({
      normalizedRequest: { method: "GET", url: "https://app.test/api/x?email=a@b.io", headers: { authorization: "Bearer t" } },
    });
    scope.captureException(new Error("boom for a@b.io"));
    await client.flush(500);
    expect(sent).toHaveLength(1);
    const body = sent[0]!;
    expect(body).toContain("boom for [email]");
    expect(body).not.toContain("a@b.io");
    expect(body).not.toContain("Bearer t");
    expect(body).not.toContain("console");
    expect(body).toContain(`"request":{"method":"GET","url":"https://app.test/api/x"}`);
  });
});

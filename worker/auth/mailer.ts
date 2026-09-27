/**
 * Email delivery behind a tiny interface so the provider is swappable.
 *
 * Production: Resend's HTTP API (plain fetch, no SDK). Needs the RESEND_API_KEY
 * secret and MAIL_FROM (a sender on a domain verified in Resend).
 * Local dev (no key, localhost): the link is logged to the console instead.
 */
export interface Mailer {
  sendMagicLink(to: string, link: string): Promise<void>;
}

export type MailEnv = Env & { RESEND_API_KEY?: string };

class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async sendMagicLink(to: string, link: string): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: "Your CreateMyQ sign-in link",
        text: `Sign in to CreateMyQ:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
        html: `<p>Sign in to CreateMyQ:</p><p><a href="${link}">Sign in</a></p><p>The link works once and expires in 15 minutes. If you did not ask for it, ignore this email.</p>`,
      }),
    });
    if (!res.ok) {
      // Don't log the body wholesale: keep it short, never log the link.
      throw new Error(`Resend send failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }
}

/** Dev only: prints the link so the flow can be tested without a provider. */
class ConsoleMailer implements Mailer {
  async sendMagicLink(to: string, link: string): Promise<void> {
    console.log(`[dev mailer] magic link for ${to}: ${link}`);
  }
}

/** Deployed without a key: refuse to send, and never put the token in logs. */
class MissingKeyMailer implements Mailer {
  async sendMagicLink(): Promise<void> {
    throw new Error("RESEND_API_KEY is not set; magic link not sent");
  }
}

export function getMailer(env: MailEnv, requestUrl: string): Mailer {
  if (env.RESEND_API_KEY) return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  const host = new URL(requestUrl).hostname;
  if (host === "localhost" || host === "127.0.0.1") return new ConsoleMailer();
  return new MissingKeyMailer();
}

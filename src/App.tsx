import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, api, setUnauthorizedHandler } from "./lib/api";

type User = { id: string; email: string };
type View =
  | { name: "loading" }
  | { name: "sign-in" }
  | { name: "verify"; token: string }
  | { name: "home"; user: User };

const button =
  "min-h-11 rounded-lg bg-ink px-5 text-surface font-medium disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

function go(path: string) {
  window.history.replaceState(null, "", path);
}

export default function App() {
  const [view, setView] = useState<View>(() => {
    if (window.location.pathname === "/auth/verify") {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
      return { name: "verify", token };
    }
    return { name: "loading" };
  });

  const toSignIn = useCallback(() => {
    go("/sign-in");
    setView({ name: "sign-in" });
  }, []);

  useEffect(() => setUnauthorizedHandler(toSignIn), [toSignIn]);

  useEffect(() => {
    if (view.name !== "loading") return;
    api<{ user: User }>("/me")
      .then(({ user }) => {
        if (window.location.pathname === "/sign-in") go("/");
        setView({ name: "home", user });
      })
      .catch(() => {
        // 401 already routed to sign-in; anything else, show sign-in too.
        toSignIn();
      });
  }, [view.name, toSignIn]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4">
      <h1 className="font-display text-4xl text-ink">CreateMyQ</h1>
      {view.name === "loading" && <p className="text-ink-muted">Loading…</p>}
      {view.name === "sign-in" && <SignIn />}
      {view.name === "verify" && (
        <Verify
          token={view.token}
          onSignedIn={(user) => {
            go("/");
            setView({ name: "home", user });
          }}
          onRestart={toSignIn}
        />
      )}
      {view.name === "home" && <Home user={view.user} onSignedOut={toSignIn} />}
    </main>
  );
}

function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-ink">
      <span aria-hidden="true">⚠ </span>
      {message}
    </p>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/request", { body: { email } });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-lg">Check your inbox.</p>
        <p className="text-ink-muted">
          If {email} is on the invite list, a sign-in link is on its way. It works once and
          expires in 15 minutes.
        </p>
        <button type="button" className={button} onClick={() => setSent(false)}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-ink-muted">CreateMyQ is invite only. Enter your email to get a sign-in link.</p>
      <label className="flex flex-col gap-2">
        <span className="font-medium">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-h-11 rounded-lg border border-ink-muted bg-white px-3 text-base"
        />
      </label>
      <ErrorText message={error} />
      <button type="submit" className={button} disabled={busy}>
        {busy ? "Sending…" : "Send me a link"}
      </button>
    </form>
  );
}

/**
 * The emailed link lands here. Signing in takes a click (a POST), so email
 * scanners that pre-fetch or even render links can't burn the one-time token.
 */
function Verify({
  token,
  onSignedIn,
  onRestart,
}: {
  token: string;
  onSignedIn: (user: User) => void;
  onRestart: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    token ? null : "This sign-in link is incomplete. Request a new one.",
  );

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const { user } = await api<{ user: User }>("/auth/verify", { body: { token } });
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ErrorText message={error} />
      {error ? (
        <button type="button" className={button} onClick={onRestart}>
          Get a new link
        </button>
      ) : (
        <button type="button" className={button} onClick={verify} disabled={busy} autoFocus>
          {busy ? "Signing in…" : "Continue to CreateMyQ"}
        </button>
      )}
    </div>
  );
}

function Home({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api("/auth/logout", { body: {} });
    } catch {
      // The session is gone either way from the user's point of view.
    }
    onSignedOut();
  }

  return (
    <div className="flex flex-col gap-4">
      <p>
        Signed in as <span className="font-medium">{user.email}</span>
      </p>
      <p className="text-ink-muted">Quizzes are coming soon.</p>
      <button type="button" className={button} onClick={signOut} disabled={busy}>
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

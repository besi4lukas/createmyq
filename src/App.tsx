import { useEffect, useState } from "react";
import { SignIn, useAuth } from "@clerk/react";
import {
  ApiError,
  api,
  setNotInvitedHandler,
  setTokenGetter,
  setUnauthorizedHandler,
} from "./lib/api";

type User = { id: string; email: string };
type Me =
  | { status: "loading" }
  | { status: "ok"; user: User }
  | { status: "not-invited" }
  | { status: "error"; message: string };

const button =
  "min-h-11 rounded-lg bg-ink px-5 text-surface font-medium disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

// Clerk's prebuilt sign-in, with every tap target at least 44px.
const signInAppearance = {
  elements: {
    formButtonPrimary: "min-h-11",
    formFieldInput: "min-h-11",
    otpCodeFieldInput: "min-h-11",
    formResendCodeLink: "min-h-11",
    identityPreviewEditButton: "min-h-11 min-w-11",
    alternativeMethodsBlockButton: "min-h-11",
    footerActionLink: "min-h-11 inline-flex items-center",
  },
};

export default function App() {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  const [me, setMe] = useState<Me>({ status: "loading" });

  // Registered before the /me effect below, so the first call carries the token.
  useEffect(() => {
    setTokenGetter(() => getToken());
    setUnauthorizedHandler(() => void signOut());
    setNotInvitedHandler(() => setMe({ status: "not-invited" }));
  }, [getToken, signOut]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    api<{ user: User }>("/me")
      .then(({ user }) => !cancelled && setMe({ status: "ok", user }))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "not_invited") return; // handler set it
        if (err instanceof ApiError && err.status === 401) return; // handler signs out
        setMe({
          status: "error",
          message: err instanceof ApiError ? err.message : "Something went wrong. Please try again.",
        });
      });
    return () => {
      cancelled = true;
      setMe({ status: "loading" });
    };
  }, [isLoaded, isSignedIn]);

  let body;
  if (!isLoaded) body = <p className="text-ink-muted">Loading…</p>;
  else if (!isSignedIn) {
    body = (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg">CreateMyQ is invite only</h2>
        <SignIn routing="hash" appearance={signInAppearance} />
      </div>
    );
  } else if (me.status === "loading") body = <p className="text-ink-muted">Loading…</p>;
  else if (me.status === "ok") body = <Home user={me.user} onSignOut={() => signOut()} />;
  else if (me.status === "not-invited") body = <NotInvited onSignOut={() => signOut()} />;
  else body = <Problem message={me.message} onSignOut={() => signOut()} />;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4">
      <h1 className="font-display text-4xl text-ink">CreateMyQ</h1>
      {body}
    </main>
  );
}

function SignOutButton({ onSignOut }: { onSignOut: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={button}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onSignOut().catch(() => setBusy(false));
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

function Home({ user, onSignOut }: { user: User; onSignOut: () => Promise<unknown> }) {
  return (
    <div className="flex flex-col gap-4">
      <p>
        Signed in as <span className="font-medium">{user.email}</span>
      </p>
      <p className="text-ink-muted">Quizzes are coming soon.</p>
      <SignOutButton onSignOut={onSignOut} />
    </div>
  );
}

function NotInvited({ onSignOut }: { onSignOut: () => Promise<unknown> }) {
  return (
    <div className="flex flex-col gap-4">
      <p role="alert" className="text-lg">
        <span aria-hidden="true">⚠ </span>
        This email is not on the invite list yet.
      </p>
      <p className="text-ink-muted">
        CreateMyQ is invite only. Ask whoever invited you to add this address, or sign out and
        use the email they invited.
      </p>
      <SignOutButton onSignOut={onSignOut} />
    </div>
  );
}

function Problem({ message, onSignOut }: { message: string; onSignOut: () => Promise<unknown> }) {
  return (
    <div className="flex flex-col gap-4">
      <p role="alert">
        <span aria-hidden="true">⚠ </span>
        {message}
      </p>
      <button type="button" className={button} onClick={() => window.location.reload()}>
        Try again
      </button>
      <SignOutButton onSignOut={onSignOut} />
    </div>
  );
}

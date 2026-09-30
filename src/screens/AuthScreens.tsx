import type { ReactNode } from "react";
import { SignIn } from "@clerk/react";
import { SignOut, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../components/Button";
import { LogoMark } from "../components/Bits";
import { useSignOut } from "../lib/useSignOut";

/**
 * Clerk's prebuilt sign-in, themed from the CSS variables in index.css (no
 * colours here) and with every tap target at least 44px. Its card chrome is
 * dropped so it sits in the page's column like the design's form.
 */
const signInAppearance = {
  variables: {
    colorPrimary: "var(--accent)",
    colorPrimaryForeground: "var(--bg)",
    colorBackground: "var(--surface)",
    colorForeground: "var(--text)",
    colorMutedForeground: "color-mix(in srgb, var(--text) 55%, transparent)",
    colorNeutral: "var(--text)",
    colorInput: "var(--surface)",
    colorInputForeground: "var(--text)",
    colorBorder: "var(--divider)",
    colorRing: "var(--accent)",
    colorDanger: "var(--wrong)",
    fontFamily: "inherit",
    borderRadius: "8px",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full max-w-none shadow-sm",
    formButtonPrimary: "min-h-11",
    formFieldInput: "min-h-11",
    otpCodeFieldInput: "min-h-11",
    formResendCodeLink: "min-h-11",
    identityPreviewEditButton: "min-h-11 min-w-11",
    alternativeMethodsBlockButton: "min-h-11",
    footerActionLink: "min-h-11 inline-flex items-center",
  },
};

function Column({ children }: { children: ReactNode }) {
  return <div className="flex max-w-[400px] flex-col gap-4.5 pt-20 sm:pt-[110px]">{children}</div>;
}

export function SignInScreen() {
  return (
    <Column>
      <LogoMark large />
      <div>
        <h1 className="mb-2.5 text-h1 text-balance">Quizzes that know their stuff.</h1>
        <p className="text-body text-pretty text-muted">
          Pick a software topic and find out what you actually know. We ask the questions.
        </p>
      </div>
      <SignIn routing="hash" appearance={signInAppearance} />
      <p className="text-meta text-muted">Invite-only. We email you a code, no passwords.</p>
    </Column>
  );
}

export function SignOutButton({ onSignOut }: { onSignOut: () => Promise<unknown> }) {
  const { busy, signOut } = useSignOut(onSignOut);
  return (
    <Button variant="secondary" disabled={busy} onClick={signOut}>
      <SignOut aria-hidden="true" className="size-4" />
      {busy ? "Signing out…" : "Sign out"}
    </Button>
  );
}

export function NotInvited({ onSignOut }: { onSignOut: () => Promise<unknown> }) {
  return (
    <Column>
      <LogoMark large />
      <h1 role="alert" className="text-h2-phone text-balance sm:text-h2">
        This email is not on the invite list yet.
      </h1>
      <p className="text-pretty text-muted">
        CreateMyQ is invite only. Ask whoever invited you to add this address, or sign out and use the email they
        invited.
      </p>
      <div>
        <SignOutButton onSignOut={onSignOut} />
      </div>
    </Column>
  );
}

export function Problem({ message, onSignOut }: { message: string; onSignOut: () => Promise<unknown> }) {
  return (
    <Column>
      <p role="alert" className="flex items-start gap-3 text-body">
        <WarningCircle aria-hidden="true" weight="fill" className="mt-0.5 size-5.5 shrink-0 text-wrong" />
        <span>
          <span className="sr-only">Error: </span>
          {message}
        </span>
      </p>
      <div className="flex flex-wrap gap-2.5">
        <Button onClick={() => window.location.reload()}>Try again</Button>
        <SignOutButton onSignOut={onSignOut} />
      </div>
    </Column>
  );
}

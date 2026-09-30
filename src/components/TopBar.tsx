import { useState } from "react";
import { House, SignOut } from "@phosphor-icons/react";
import { navigate } from "../lib/router";
import { LogoMark } from "./Bits";

const navButton =
  "flex min-h-11 min-w-11 items-center justify-center gap-[7px] rounded-md px-3 text-ui hover:bg-text/7 active:bg-text/14";

/**
 * App shell top bar. Review and Preferences join the nav with their tickets
 * (STM-25, FR-23); until Preferences lands, Sign out lives here.
 */
export function TopBar({ onHome, onSignOut }: { onHome: boolean; onSignOut: () => Promise<unknown> }) {
  const [signingOut, setSigningOut] = useState(false);
  return (
    <header className="flex items-center gap-1.5 px-5 py-3 sm:px-14">
      <a
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate({ name: "home" });
        }}
        className="mr-auto flex min-h-11 items-center gap-[9px] rounded-md text-text"
      >
        <LogoMark />
        <span className="text-title font-medium tracking-[-0.01em]">CreateMyQ</span>
      </a>
      <nav aria-label="Main" className="flex items-center gap-1.5">
        <a
          href="/"
          aria-current={onHome ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate({ name: "home" });
          }}
          className={`${navButton} ${onHome ? "bg-accent/12 text-accent hover:bg-accent/12" : "text-neutral-300"}`}
        >
          <House aria-hidden="true" className="size-4.5" />
          <span className="sr-only sm:not-sr-only">Home</span>
        </a>
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            onSignOut().catch(() => setSigningOut(false));
          }}
          className={`${navButton} text-neutral-300 disabled:opacity-45`}
        >
          <SignOut aria-hidden="true" className="size-4.5" />
          <span className="sr-only sm:not-sr-only">{signingOut ? "Signing out…" : "Sign out"}</span>
        </button>
      </nav>
    </header>
  );
}

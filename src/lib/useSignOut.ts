import { useState } from "react";

/** Sign out, disabled while it runs; re-enabled if it fails so the user can try again. */
export function useSignOut(onSignOut: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  function signOut() {
    setBusy(true);
    onSignOut().catch(() => setBusy(false));
  }
  return { busy, signOut };
}

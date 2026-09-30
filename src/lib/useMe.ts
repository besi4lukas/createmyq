import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { ApiError, api, setNotInvitedHandler, setTokenGetter, setUnauthorizedHandler } from "./api";

type User = { id: string; email: string };
export type Me =
  | { status: "loading" }
  | { status: "ok"; user: User }
  | { status: "not-invited" }
  | { status: "error"; message: string };

/**
 * Who is signed in, as far as CreateMyQ is concerned. Wires Clerk into the API
 * client (token on every call, 401 signs out, 403 not_invited), then asks
 * /api/me whether this Clerk user is invited.
 */
export function useMe() {
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

  return { isLoaded, isSignedIn, me, signOut: () => signOut() };
}

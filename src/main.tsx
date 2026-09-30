import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import App from "./App.tsx";
// Inter 400/500/600, served from our own origin (no third-party font host).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./index.css";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
if (!publishableKey) {
  throw new Error(
    "VITE_CLERK_PUBLISHABLE_KEY is not set. Add it to .env.local (locally) or the GitHub variable (CI) and rebuild.",
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* cssLayerName puts Clerk's styles in a layer below Tailwind's utilities (see index.css). */}
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/" appearance={{ cssLayerName: "clerk" }}>
      <App />
    </ClerkProvider>
  </StrictMode>,
);

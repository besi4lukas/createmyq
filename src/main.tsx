import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import App from "./App.tsx";
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

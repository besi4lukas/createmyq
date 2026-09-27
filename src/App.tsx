import { useEffect, useState } from "react";

type Health = "checking" | "ok" | "down";

export default function App() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => setHealth(res.ok ? "ok" : "down"))
      .catch(() => setHealth("down"));
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4">
      <h1 className="font-display text-4xl text-ink">Stumper</h1>
      <p className="text-ink-muted">Scaffold is up. API health: {health}</p>
    </main>
  );
}

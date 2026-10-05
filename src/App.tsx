import { useCallback, useEffect, useRef, useState } from "react";
import { Loading } from "./components/Bits";
import { Toast, useToast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import type { Quiz, QuizResult } from "./lib/quiz";
import { navigate, pathOf, useRoute } from "./lib/router";
import { useMe } from "./lib/useMe";
import { NotInvited, Problem, SignInScreen } from "./screens/AuthScreens";
import { HomeScreen } from "./screens/HomeScreen";
import { QuizScreen } from "./screens/QuizScreen";
import { ResultScreen } from "./screens/ResultScreen";
import { SetupScreen } from "./screens/SetupScreen";

/** Page gutters: 20px on a phone, 56px on desktop. */
const page = "px-5 pb-12 sm:px-14";

export default function App() {
  const { isLoaded, isSignedIn, me, signOut } = useMe();

  let body;
  if (!isLoaded) body = <Loading />;
  else if (!isSignedIn) body = <SignInScreen />;
  else if (me.status === "loading") body = <Loading />;
  else if (me.status === "ok") return <SignedIn onSignOut={signOut} />;
  else if (me.status === "not-invited") body = <NotInvited onSignOut={signOut} />;
  else body = <Problem message={me.message} onSignOut={signOut} />;

  return <main className={`${page} min-h-dvh`}>{body}</main>;
}

/** The signed-in app: top bar, the current screen, and the toast. */
function SignedIn({ onSignOut }: { onSignOut: () => Promise<unknown> }) {
  const route = useRoute();
  const { message, show } = useToast();
  // Handed from screen to screen in memory: the quiz just started, the result just made.
  const [started, setStarted] = useState<Quiz | null>(null);
  const [result, setResult] = useState<QuizResult | null>(null);

  // The quiz handed over at start is only fresh right after starting. Back and
  // forward can revisit /quiz much later, so the quiz screen then fetches it.
  useEffect(() => {
    const forget = () => setStarted(null);
    window.addEventListener("popstate", forget);
    return () => window.removeEventListener("popstate", forget);
  }, []);

  const onStarted = useCallback(
    (quiz: Quiz, resumed: boolean) => {
      setStarted(quiz);
      if (resumed) show("You already had a quiz going, so we picked it back up.");
      navigate({ name: "quiz" });
    },
    [show],
  );

  const onFinished = useCallback((r: QuizResult) => {
    setStarted(null);
    setResult(r);
    navigate({ name: "results" }, { replace: true });
  }, []);

  const onLeave = useCallback(() => {
    setStarted(null);
    navigate({ name: "home" });
    show("Saved. Resume from home any time.");
  }, [show]);

  // A new screen: move focus to its content so Tab starts there, not at the top
  // of a page that no longer exists. A screen can name its own target with
  // data-autofocus (the results heading, so the score is read first). The quiz
  // screen focuses its question itself.
  const mainRef = useRef<HTMLElement>(null);
  const path = pathOf(route);
  useEffect(() => {
    if (path === "/quiz") return;
    const target = mainRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? mainRef.current;
    target?.focus({ preventScroll: true });
  }, [path]);

  // A refresh on /results has nothing to show: the result lived in memory.
  const resultsMissing = route.name === "results" && !result;
  useEffect(() => {
    if (resultsMissing) navigate({ name: "home" }, { replace: true });
  }, [resultsMissing]);

  let screen;
  switch (route.name) {
    case "home":
      screen = <HomeScreen />;
      break;
    case "setup":
      screen = <SetupScreen key={route.category} category={route.category} onStarted={onStarted} />;
      break;
    case "quiz":
      screen = <QuizScreen started={started} onFinished={onFinished} onLeave={onLeave} />;
      break;
    case "results":
      screen = result ? <ResultScreen result={result} /> : null;
      break;
    default:
      screen = route satisfies never; // every route has a screen
  }

  return (
    <div className="min-h-dvh">
      <TopBar onHome={route.name === "home"} onSignOut={onSignOut} />
      <main ref={mainRef} tabIndex={-1} className={`${page} pt-2 outline-none`}>
        {screen}
      </main>
      <Toast message={message} />
    </div>
  );
}

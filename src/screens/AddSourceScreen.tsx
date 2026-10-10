/**
 * "Bring your own material" (design v2, screen 5) at /add: a PDF, an article
 * link or a YouTube link. On success the user lands on the source's status
 * screen. Home opens the same form inline (UploadForm, compact); this page
 * stays for deep links.
 */
import { UploadForm } from "../components/UploadForm";
import { navigate } from "../lib/router";

export function AddSourceScreen() {
  return (
    <div className="flex max-w-[600px] flex-col gap-5.5 pt-3">
      <div>
        <h1 className="text-h2-phone sm:text-h2">Bring your own material</h1>
        <p className="mt-1.5 text-muted text-pretty">
          Anything about software engineering. We’ll read it, check it’s on topic, and write 20 to 25 questions.
        </p>
      </div>
      <UploadForm onCreated={({ id }) => navigate({ name: "source", id })} />
    </div>
  );
}

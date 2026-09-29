# TASKS: CreateMyQ Beta (7-day sprint)

**Sprint goal:** by the end of Day 7, five invited people can sign in, take a quiz on a built-in category, upload their own PDF and get a quiz from it, and see what they got wrong and why. Everything runs on Cloudflare with Neon behind Hyperdrive.

Rules: one ticket per session, one branch, one PR. See [CLAUDE.md](CLAUDE.md) for the definition of done.
🔍 = human reads every line. 🗄️ = allowed to change schema. ✍️ = human-written, not Claude.

## Milestones

| | Milestone | Lands | True when |
|---|---|---|---|
| [ ] | M1 Foundation | End of Day 1 | Deployed skeleton, database live, migrations run |
| [ ] | M2 Playable | End of Day 3 | A real quiz can be taken end to end on seeded questions |
| [ ] | M3 Ingestion | End of Day 5 | An uploaded PDF becomes a real quiz |
| [ ] | M4 Shippable | End of Day 7 | Gate, quality filter, limits and polish in, five people invited |

---

## Day 1: Foundation (6.5h)

- [x] **STM-1 Scaffold the repo** · 2h · depends: none
  Vite, React, TypeScript, Tailwind, Hono on Workers, served through Workers Assets.
  **Done when:** `wrangler dev` serves the page, `/api/health` returns ok, a deploy to workers.dev succeeds.
  _Status:_ done. Deployed to https://createmyq.besi4lukas.workers.dev (version `858ef120`, 2026-09-27). Live `/api/health` returns ok, `/` and SPA deep links return 200. Run dev with `npx wrangler dev` or `npm run dev`, not the global `wrangler`.

- [x] **STM-2 CI and environments** · 1h · depends: STM-1
  Typecheck, lint and build on every PR. Deploy on merge to main. Secrets through wrangler.
  **Done when:** a PR shows a green check, and a merge deploys automatically.
  _Status:_ done. `.github/workflows/ci.yml` checks every PR (PR #1 green) and the merge to main deployed automatically (run 36340935779). Live `/api/health` ok, unknown `/api` routes return JSON 404.

- [x] **STM-3 Neon + Hyperdrive** · 1h · depends: STM-1
  Neon project, Hyperdrive binding, DB client created per request, `nodejs_compat` on.
  **Done when:** `/api/health/db` runs a real query through Hyperdrive and returns a row.
  _Status:_ done. Neon project `sweet-pine-24006217` (branch `production`) behind Hyperdrive config `createmyq-db` (`02d4ca5e5664448bb41400bfff148cf7`), `pg` client per request in `worker/db/client.ts`. Locally `/api/health/db` returns `now()` + `version()` (PostgreSQL 18.6). Local dev reads the Neon URL from `.env` (see `.env.example`), not `.dev.vars`. Live `/api/health/db` returns a row through the deployed Hyperdrive (PR #2, run 36345593528).

- [x] **STM-4 Drizzle schema and migrations** 🗄️ · 2.5h · depends: STM-3
  Every table on the design tab: `users`, `invites`, `categories`, `sources` (incl. `visibility`, **unique** `content_hash`), `source_chunks`, `questions`, `sessions`, `session_questions` (with `question_snapshot`), `answers`, `misses`, `flags`.
  **Done when:** migrations run clean against an empty DB, and a second run is a no-op.
  _Status:_ done (PR #3, deploy run 36351125069). 15 tables in `worker/db/schema.ts`, migrations `drizzle/0000_enable_pgvector.sql` + `0001_schema.sql`. Verified on a throwaway Neon branch: clean apply on an empty DB, second and third runs are no-ops (identical schema fingerprint), duplicate `content_hash` and duplicate `idempotency_key` rejected. Adds `magic_links` + `auth_sessions` for STM-5, `source_uploads` for FR-10a, `model_calls` for cost control. Applied to `production` by the user with `npm run db:migrate` (reads `DATABASE_URL_UNPOOLED` from `.env.local`).

## Day 2: Access and the question bank (8h, the heaviest day)

- [x] **STM-5 Clerk sign in** · 3h · depends: STM-4
  Clerk email-code sign-in (Restricted mode), Clerk session token sent as a bearer token and verified in the Worker with `CLERK_JWT_KEY`, `invites` checked on every request, user created on first request, middleware rejecting every unauthenticated route. 7-day session (Clerk free plan). Replaces the magic-link design (FR-2/FR-3) by the user's decision.
  **Done when:** an email not on the allowlist cannot get in (neither a stranger nor a Clerk user missing from `invites`), a signed-out or invalid token gets a JSON 401, and a session survives a refresh.
  _Status:_ done (PR #5, deploy run 36608469109; magic-link PR #4 closed). Browser-tested against the real Clerk dev instance: email-code sign-in, session survives reload and tab reopen, uninvited Clerk user → 403 `not_invited` with no user row, tampered token → 401, sign out, per-user `/api/me`. Live: `/api/health` 200, `/api/me` and `/api/health/db` → JSON 401 without a token; the user signed in on workers.dev. Adding a person = an `invites` row + a Clerk user.

- [x] **STM-6 Write the first 20 System Design questions** ✍️ · 2h · depends: none
  Spread across Beginner / Intermediate / Advanced. _Can move to an evening before the sprint._
  **Done when:** 20 questions exist as JSON with answer, explanation, difficulty and format. **Human writes these, not Claude.**
  _Status:_ done (PR #6). 40 questions, written by Claude at the user's request (the user chose to skip the ✍️ rule for this ticket), then independently reviewed twice with fact checks against primary sources (Postgres docs, RFC 9562, RFC 9110, Raft, AWS availability whitepaper). `seed/system-design.json`: category `system-design`, 40 multiple-choice questions (`sd-001`…`sd-040`), 14 beginner / 14 intermediate / 12 advanced, 39 topics, correct-answer positions A/B/C/D 10/10/10/10. Reviewed against Haladyna/Downing/Rodriguez, NBME and Bloom; the items flagged in the first review (sd-007, sd-013, sd-015, sd-016, sd-017) were revised, and the final review fixed sd-015, 019, 024, 028 and 035. MC only because the vertical slice is "one category, one format" and STM-11 is MC. Payload is `{ options: string[4], answer: <exact option text> }`, which STM-7's Zod schema should enforce.

- [x] **STM-7 Seed script** · 1h · depends: STM-4, STM-6
  Loads a question JSON file into the bank, with validation.
  **Done when:** all questions in the file (40 in `seed/system-design.json`) are in the DB as approved, and rerunning the script does not duplicate them.
  _Status:_ done (PR #7). `npm run db:seed -- <file> [--dry-run]` (`scripts/seed.ts`). Validates the whole file with Zod before connecting (payload schema in `worker/questions/payload.ts`, file schema in `scripts/seed-file.ts`), then one transaction: upsert category by slug, upsert questions by `external_id` as origin `seed`, status `approved`. Re-runs update changed content only and never touch `status`, so a flagged or retired question stays hidden. Reports inserted / updated / unchanged; `--dry-run` rolls the transaction back. Verified on throwaway Neon branch `stm-7-seed-test` (deleted): 40 inserted with every field matching the JSON, rerun 0/0/40, one edited explanation → updated 1, a corrupted file reports all 7 problems and writes nothing, dry run writes nothing, a `pending_review` question stays hidden after re-seeds. Production seeded by the user (40 approved questions).

- [x] **STM-8 Quiz assembly endpoint** 🔍 · 2h · depends: STM-7
  Category, difficulty and length in, sampled questions out. Excludes anything the user saw in the last 30 days, with a documented fallback when the pool runs dry.
  **Done when:** two consecutive calls return different sets, and the exclusion window provably works.
  _Status:_ done (PR #8, deploy run 36632087441). `GET /api/quiz?category=<slug>&difficulty=<beginner|intermediate|advanced>&length=<5|10|20>` in `worker/quiz/assemble.ts`: one read-only query over approved MC questions, private-source filter (FR-10a), questions from the user's finished sessions in the last 30 days last, oldest-seen first as the fallback, random otherwise. Returns id/format/difficulty/topic/prompt/options (no answer, no explanation), `short: true` when the pool is smaller than the length. 400 bad input, 404 unknown category or empty pool. Verified end to end on throwaway Neon branch `stm-8-assembly-test`.

## Day 3: The quiz loop (9h, over budget; STM-12 spills to Day 4)

- [x] **STM-9 Session Durable Object** · 3h · depends: STM-8
  One per user. Holds create, answer, resume and finish, with preferences alongside.
  **Done when:** a refresh mid-quiz resumes at the right question with prior answers intact.
  _Status:_ done (PR #9, deploy run 36636613066, version 09cb0a62; DO migration v1 applied). `UserSession` SQLite-backed DO (`worker/durable/user-session.ts`, migration `v1`), one per user via `idFromName(users.id)`. Routes in `worker/quiz/session-routes.ts`: `POST /api/session` {category, difficulty, length, mode} (409 `quiz_in_progress` + the quiz if one is running), `GET /api/session` (resume), `POST /api/session/answer` {quizId, index, option} (graded in the DO, idempotent by index, 409 for a quiz not in progress), `POST /api/session/finish` {quizId} (score + review; finishing an already-finished quiz returns its result and never touches a newer one), `GET/PUT /api/prefs` (defaultDifficulty, defaultMode, defaultLength, formats). Practice reveals verdict + explanation per answer; Exam only at finish. Finish moves the quiz to `quiz:done:<quizId>` and deletes nothing: the flush is STM-10's `TODO(STM-10)`. Verified on throwaway Neon branch `stm-9-session-test` (deleted), including a `wrangler dev` restart mid-quiz resuming at index 2 with both answers; the quizId fix re-verified on `stm-9-fix-test` (deleted).

- [ ] **STM-10 Session flush to Postgres** · 2h · depends: STM-9
  One transaction on finish, idempotency key, retry on alarm, local state cleared only after confirmation.
  **Done when:** a forced write failure still lands the session on retry, and calling finish twice produces exactly one row.
  _Status:_ in review (PR open, not merged or deployed). `finish()` writes `quiz:done:<quizId>` and a +5 s alarm atomically, then the route awaits `flush()` for up to 5 s (`saved` in the response). One transaction in `worker/quiz/flush.ts` (`sessions` ON CONFLICT (idempotency_key) DO NOTHING, `session_questions` with snapshots, `answers` for answered questions only; misses left to STM-25). The DO entry is deleted only after commit. Single-flight per quiz in memory. `alarm()` never throws and retries at 5 s × 2ⁿ capped at 10 min forever (`session_flush_STUCK` after 10 failed passes). Fault injection is config only (`scripts/pg-fault-proxy.ts`). Verified on throwaway Neon branch `stm-10-flush-test` (deleted): happy path, 3 concurrent + repeated finishes = 1 row, 3 forced failures then landed, commit-then-kill-`wrangler dev` recovered by the alarm after restart (`inserted:false`, 1 row), 4 quizzes over 2 users queued through an outage each landed once, hung connection timed out and landed, an STM-9-era entry (no alarm, no userId) flushed on wake, and STM-8 assembly excludes the flushed questions. **After deploy:** any `quiz:done:*` entries left in production by STM-9 flush the next time their user's object wakes.

- [ ] **STM-11 Quiz UI** · 2.5h · depends: STM-9
  One question at a time, multiple choice, progress, Practice and Exam modes, number keys to select, Enter to submit.
  **Done when:** a full quiz can be taken on a phone with no mouse.

- [ ] **STM-12 Results screen** · 1.5h · depends: STM-10
  Score, per-topic breakdown, every question with the correct answer and explanation.
  **Done when:** finishing a quiz lands here, and the session is visible in Postgres.

## Day 4: Getting material in (8.5h)

- [ ] **STM-13 Upload path** · 2h · depends: STM-5
  Worker issues a short-lived signed R2 URL, the browser PUTs directly, and a source row is created with status.
  **Done when:** a 20 MB PDF uploads without passing through the API, and the row appears.

- [ ] **STM-14 Text extraction** · 2.5h · depends: STM-13
  PDF through unpdf (50-page and 20 MB caps), article URLs, YouTube captions. Normalise and fingerprint.
  **Done when:** all three source types produce clean text, and a scanned PDF fails with "I could not read this file. Scanned PDFs are not supported yet."

- [ ] **STM-15 Queue + Workflow skeleton** 🔍 · 2.5h · depends: STM-14
  Per-step retries, stubbed generation.
  **Done when:** killing a step mid-run resumes from that step rather than restarting the job.

- [ ] **STM-16 Fingerprint cache + generation lock DO** · 1.5h · depends: STM-15
  Durable Object keyed by content hash.
  **Done when:** two simultaneous uploads of the same file trigger one generation run, and the second user gets the bank.

## Day 5: Making questions (7h, M3 lands)

- [ ] **STM-17 Chunking** · 1.5h · depends: STM-14
  Section headings preserved so questions can cite their source.
  **Done when:** chunks carry a heading path and a character range.

- [ ] **STM-18 Generation step** 🔍 · 3h · depends: STM-15, STM-17
  Zod schema per format, call through AI Gateway, validate, retry once, discard on second failure, store with citation. Target 20–25, fail below 5.
  **Done when:** a real PDF produces a real quiz end to end, and a deliberately malformed response never reaches the DB.

- [ ] **STM-19 Quality filter and dedupe** · 2.5h · depends: STM-18
  Rubric score per question, drop below threshold, drop near-duplicates by vector similarity.
  **Done when:** before/after counts are reportable on a real source, and two near-identical questions collapse to one.

## Day 6: The gate (7.5h)

- [ ] **STM-20 Labelled evaluation set** · 1.5h · depends: none
  50 sources, half software and half not, with expected verdicts.
  **Done when:** the set is in the repo as fixtures and can be loaded by a script.

- [ ] **STM-21 `Classifier` interface + benchmark** · 3h · depends: STM-20
  Two implementations, Jev and a single model call, plus a benchmark script scoring both on accuracy, latency and cost. The gate must clear **90% accuracy** before going live.
  **Done when:** both implementations have real numbers, and swapping them is a one-line change.

- [ ] **STM-22 Wire the gate into the Workflow** · 1.5h · depends: STM-21
  Sample chunks from start, middle and end, aggregate, fall through to the model on low confidence, record every decision with its inputs.
  **Done when:** a cooking PDF is refused with "This looks like cooking. CreateMyQ only covers software engineering right now.", a software PDF passes, and both decisions are logged.

- [ ] **STM-23 Difficulty and format tagging** · 1.5h · depends: STM-21
  Per question, by the classifier, at write time.
  **Done when:** every stored question carries a difficulty and a format assigned by the classifier, not by the generator.

## Day 7: Limits, polish, ship (8h)

- [ ] **STM-24 Preferences and rate limits in the user DO** · 2h · depends: STM-9
  Default difficulty, feedback mode, formats, daily generation cap, global spend ceiling.
  **Done when:** hitting the cap gives a message with a reset time, and the spend ceiling disables generation rather than running up a bill.

- [ ] **STM-25 Misses and the review quiz** · 1.5h · depends: STM-12
  Record misses, build a quiz from them, clear a miss after two correct answers.
  **Done when:** the review quiz contains only questions actually missed.

- [ ] **STM-26 Visual polish** · 2h · depends: STM-11
  Theme variables in one file, answer reveal animation, question transitions, reduced motion respected, 44px targets, never colour alone.
  **Done when:** it feels good on a phone and stays usable with motion disabled.

- [ ] **STM-27 Observability and cost report** · 1.5h · depends: STM-18
  Sentry, Workers Logs, and a script reporting quizzes taken, cache hit rate and spend.
  **Done when:** "What did this week cost" is answerable with one command.

- [ ] **STM-28 Invite five people and watch them use it** · 1h · depends: everything
  **Done when:** five real people have completed a quiz and their complaints are written down.

---

## Cut list (in cut order; nothing depends on these)

If two days behind by Day 4, take all three at once and protect Day 7.

1. [ ] **Short answer format and rubric grading** (~4h). Beta ships multiple choice only.
2. [ ] **Flag button and moderation threshold** (~1.5h). Friends can report problems directly for now.
3. [ ] **Computer Science Fundamentals as a second category** (~2h + question writing). One category proves the loop.

## Beta scope with no ticket yet

These are in the design tab's "What ships in beta" or FR list, but no ticket above covers them. Decide whether each is a new ticket, is folded into an existing one, or is deferred.

- [ ] Sign out from the app (FR-3). Could fold into STM-5.
- [ ] Share-to-group toggle on sources, and private-source serving rules (FR-10a). The column is in STM-4, but there is no UI or query ticket.
- [ ] Upload / paste-a-link UI, and generation progress the user can leave and return to (FR-7, FR-13). STM-13 covers only the signed-URL path.
- [ ] Preferences UI and applying defaults to new quizzes (FR-23). STM-24 covers storage only.
- [ ] Per-model-call token and cost recording (cost control NFR). Partly STM-27.
- [ ] Account deletion that keeps generated questions but strips the link (security NFR). Also deletes the person's Clerk user.
- [ ] Operator script to add invites. Needed before STM-28. It inserts the `invites` row and creates the Clerk user (Backend API, `CLERK_SECRET_KEY` on the operator's machine only).
- [ ] 🗄️ Drop the unused `magic_links` and `auth_sessions` tables (left over from the magic-link design; STM-5 moved to Clerk).

## Risks being watched

| Risk | Signal | Response |
|---|---|---|
| Question quality is mediocre | I would not want to answer my own generated questions | Stop feature work and spend a day on the generation prompt and rubric |
| Jev underperforms the baseline | STM-21 shows worse accuracy or no cost saving | Keep the model classifier and the interface, and write up the comparison |
| DO → Postgres flush is flaky | Sessions missing after finish | Stop and fix immediately |
| Sprint runs long | Two days behind by Day 4 | Take all three cuts at once |

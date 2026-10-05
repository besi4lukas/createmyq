# CLAUDE.md

**CreateMyQ** is an invite-only quiz app for 50–100 friends and family. A user picks a built-in category, or uploads a PDF / article URL / YouTube link, and gets a quiz. Then they see what they got wrong and why. There is one subject area, software engineering, and off-topic sources are refused.

Source docs: *CreateMyQ Paper First Design* (the "design tab") and *Build tickets*. Tickets are tracked in [TASKS.md](TASKS.md).

## The one idea that shapes everything

**Making questions and taking a quiz are separate things that happen at different times.** Generation is slow, costs money and sometimes fails, so it runs in the background (Queue → Workflow) and writes to a shared question bank in Postgres. Taking a quiz only reads from that bank. It must be instant and must never call a model.

## Stack

| Piece | Where |
|---|---|
| Vite + React 19 + TypeScript | `src/` (frontend SPA) |
| Tailwind v4, theme variables in **one file** | `src/index.css` (`@theme`) |
| shadcn/ui + Radix (copied into repo when needed) | `src/components/ui/` |
| Motion for React (transform/opacity only, respects reduced motion) | STM-26 |
| Hono on Workers | `worker/` (all routes under `/api`) |
| Workers Assets serves the built SPA from the same Worker | `wrangler.jsonc` |
| Neon Postgres via Hyperdrive, Drizzle ORM | STM-3, STM-4 |
| Durable Objects: per-user session + prefs; per-content-hash generation lock | STM-9, STM-16 |
| R2 (uploads), Queues + Workflows (generation) | STM-13, STM-15 |
| Jev classifier behind a `Classifier` interface; model calls via AI Gateway | STM-21, STM-18 |
| Clerk (email code sign-in, dev instance for now); `@clerk/react` + `@clerk/backend` | STM-5 |
| Sentry + Workers Logs | STM-27 |

No Next.js, no second host, no CORS. The frontend and API share one origin and one deploy.

## Commands

```bash
npm run dev         # Vite + Cloudflare plugin: SPA and Worker together (workerd locally)
npm run typecheck   # tsc -b across app, worker and node configs
npm run lint        # eslint
npm test            # vitest: pure logic + the UserSession DO over a fake storage (no DB, no workerd)
npm run build       # typecheck + vite build → dist/
npm run deploy      # build + wrangler deploy
npm run cf-typegen  # regenerate worker-configuration.d.ts. Run after every wrangler.jsonc change
npm run db:generate # diff worker/db/schema.ts → new SQL migration in drizzle/ (schema tickets only)
npm run db:migrate  # apply pending migrations to DATABASE_URL_UNPOOLED (from .env.local or the shell)
npm run db:check    # sanity-check the migration history
npm run db:seed -- seed/<file>.json [--dry-run]  # validate a question file, then upsert it by external_id in one transaction
```

Migrations use the direct (unpooled) Neon URL, never Hyperdrive. Test them on a throwaway Neon branch first: `DATABASE_URL_UNPOOLED="$(neon connection-string <branch>)" npm run db:migrate`. pgvector is created by `drizzle/0000_enable_pgvector.sql` (drizzle-kit does not create extensions).

`db:seed` targets `SEED_DATABASE_URL` if set, else `DATABASE_URL_UNPOOLED` (shell, then `.env.local`), and prints the Neon endpoint id it is about to write to. It never changes `status` on an existing question (a flagged or retired question stays hidden), and never touches questions missing from the file. `--dry-run` runs the transaction and rolls it back.

### CI and deploy

`.github/workflows/ci.yml` runs typecheck, lint, test and build on every PR and push to main. A push to main (a merge) then runs `npm run deploy` with the wrangler version from `package-lock.json`. Deploys never overlap.

- GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`. Set them with `gh secret set <NAME>`.
- Runtime secrets for the Worker go through `npx wrangler secret put <NAME>`, never the repo or the CI config. Locally they live in `.dev.vars`.
- Always use `npx wrangler`, not a global `wrangler`.

## Layout

```
src/                  React app (browser only, never import from worker/)
src/index.css         the theme: every colour, type size, radius and shadow (Nocturne tokens, see "Frontend")
src/lib/              api.ts (fetch + Clerk token, ApiError, friendlyError), quiz.ts (typed quiz API, DIFFICULTIES/QUIZ_LENGTHS/MODES), router.ts (tiny History API router, linkTo), hooks: useAsync (load on mount), useMe (Clerk + /api/me), useSignOut
src/components/       our own small primitives (Button, Segmented, Tag, Toast, TopBar); shadcn copies go in src/components/ui/
src/screens/          one file per screen (Auth, Home, Setup, Quiz, Result placeholder): views that compose hooks
src/quiz/             question-screen parts: OptionList, RevealPanel, useQuizKeys, useActiveQuiz (load/resume), useQuizRunner (phase machine, calls, keyboard, focus)
worker/index.ts       Hono app, basePath /api: middleware and route wiring only
worker/http.ts        apiError(c, status, message, extra?) (every error body is { error, code?, … }), readJson(c)
worker/lib/           assertNever (exhaustive switches), withTimeout (race + always clear the timer)
worker/quiz/assemble.ts  quiz assembly (STM-8): the one SQL query, pickQuestions() (category lookup + assembly + the 404s)
worker/quiz/quiz-routes.ts  GET /api/quiz?category=&difficulty=&length=
worker/quiz/session-routes.ts  STM-9 routes: POST/GET /api/session, POST /api/session/answer, POST /api/session/finish, GET/PUT /api/prefs
worker/quiz/schemas.ts  request + prefs Zod schemas, shared by the routes and the DO (enums from Drizzle)
worker/quiz/session-state.ts  the quiz as data and its pure rules: newQuiz, grade (switch per format), answerQuiz, scoreQuiz, toPublicQuiz, toResult
worker/durable/user-session.ts  UserSession DO (STM-9), one per user via idFromName(users.id); storage, flush, alarm; exported from worker/index.ts
worker/quiz/flush.ts   STM-10: writeFinishedSession(), the one-transaction write of a finished quiz (called only by the DO)
worker/questions/payload.ts  Zod schemas for questions.payload per format; payloadByFormat + withFormatPayload(shape) is the one place a format joins the union
worker/testing/       test-only: cloudflare:workers stub (aliased in vitest.config.ts) and a fake DO state; *.test.ts sit next to the code
scripts/              operator scripts, run with tsx, type-checked by tsconfig.node.json (seed.ts, seed-file.ts, pg-fault-proxy.ts: dev-only flush fault injection)
wrangler.jsonc        Worker config and bindings (bindings are added by the ticket that needs them)
worker-configuration.d.ts  generated by `wrangler types` (gives the global `Env` type)
worker/db/schema.ts   Drizzle schema (every Postgres table); client.ts gives withDb(env, ctx, db => …)
drizzle/              generated SQL migrations + meta (never edit an applied migration)
drizzle.config.ts     drizzle-kit config
tsconfig.*.json       app / worker / node projects, referenced from tsconfig.json
```

Expected additions as tickets land: more DOs in `worker/durable/`, `worker/workflows/`, `worker/classifier/`, `seed/` (question JSON), `scripts/` (operator scripts: seed, invite, cost report, benchmark), `fixtures/eval/` (gate eval set).

## Frontend (STM-11)

- Design source: the Claude Design handoff (Nocturne design system, "CreateMyQ Prototype"). Question layout C (Split), results layout B (Big number).
- **Tokens only.** `src/index.css` switches Tailwind's default palette, type scale, radii and shadows off (`--color-*: initial` etc.) and defines ours: `bg`, `surface`, `text`, `muted`, `label`, `accent`, `divider`, `wrong`/`wrong-bg`/`wrong-bd`, `neutral-100…900`, `accent-100…900`; `text-tag|meta|small|ui|body|title|h4|q|h2|h1|counter|score`; `rounded-sm|tag|badge|md|panel|tile|lg`; `shadow-sm|md|lg|selected|glow`. No raw colours in components. Light theme tokens exist under `[data-theme="light"]`; the switch arrives with the Preferences screen.
- Primary buttons are outlined, never filled. Headings max weight 500. Inter 400/500/600 self-hosted via `@fontsource/inter`; icons are `@phosphor-icons/react`.
- Choice controls are native radio inputs (`Segmented`, `OptionList`): keyboard and screen-reader behaviour for free, so no Radix yet.
- Motion: only an opacity fade on options and the checking dots; the reduced-motion guard in `index.css` turns every transition and animation off. Transitions and the reveal animation are STM-26.
- Routes: `/`, `/setup/<category>`, `/quiz`, `/results` (in memory only; a refresh goes home). `/quiz` always resumes from `GET /api/session`.

## Where state lives (the rule)

- **Belongs to one user and changes constantly → Durable Object** (one per user): the in-progress quiz session, preferences, daily generation counter and rate limits, checkpoints.
- **Shared, or ever queried across users → Postgres**: question bank, finished sessions + answers, misses, sources and their fingerprints and classification decisions, flags.
- Generation **never** happens inside a user's DO. It is a central job writing to a central pool.

### DO → Postgres flush (the one place data can be lost)
On finish the DO writes the whole session in **one transaction** with an **idempotency key**. On failure it keeps the data and retries via **alarm**. **Nothing is deleted from the DO until Postgres confirms.** Calling finish twice must produce exactly one row. Losing a friend's results is the one unacceptable bug.

How STM-10 does it (`worker/durable/user-session.ts`, `worker/quiz/flush.ts`):
- `finish()` (sync) writes `quiz:done:<quizId>`, deletes `quiz:active` and sets an alarm for +5 s, in one synchronous turn, so they commit together. The route then awaits `flush(quizId)` for up to 5 s (usually the session is in Postgres before the response; the response says `saved: true|false`). The alarm is the safety net either way.
- One transaction (`writeFinishedSession`): `sessions` `ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`. A conflict means an earlier attempt committed everything, so it counts as success. Then `session_questions` (snapshot + `question_id`, null if the question is gone) and `answers` (MC: `correct`/`incorrect`, `graded_by 'code'`). **Unanswered questions have a `session_questions` row and no `answers` row.** `misses` are **not** written here (STM-25 derives them from `answers`).
- The entry is deleted only after the transaction resolves. It is moved to `quiz:last`, so a retried finish of the latest quiz still gets its result. A crash anywhere converges through the idempotency key.
- Concurrency: input gates do not hold events during network I/O, so `flush`/`alarm`/`finish` can interleave. An in-memory single-flight map (`inFlight`, by quizId) makes every caller share one attempt, and only that attempt deletes. Each attempt times out after 20 s.
- `alarm()` never throws (the runtime gives up after 6 retries). It flushes every `quiz:done:*` independently and, while any are left, reschedules itself: 5 s × 2ⁿ, capped at 10 min, forever. It keeps the earlier of its time and any existing alarm. Logs: `session_flush_ok`, `session_flush_failed`, `session_flush_retry_scheduled` and, after 10 failed passes in a row, `session_flush_STUCK` (console.error). Ids only, no PII. On wake, the constructor sets an alarm if there are unflushed entries and none is set (covers STM-9-era entries, which also lack `userId` and fall back to `ctx.id.name`).
- Dev fault injection is **config only**; the Worker has no fault hooks. `scripts/pg-fault-proxy.ts` is a local pg proxy in front of a throwaway branch. Point `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` at it and arm `fail-flush` (drop at the INSERT, mid-transaction), `lose-commit` (commit, then drop the reply) or `hang-flush` over `localhost:6544` (see the file header). Sign-in and other queries pass through.

### UserSession DO (STM-9)
Sync KV storage (`ctx.storage.kv`), every method synchronous, so nothing interleaves. Keys: `quiz:active` (at most one quiz in progress: full snapshot incl. answers, `answers[]` in order, public `quizId` and private `idempotencyKey` made at start), `quiz:done:<quizId>` (finished, awaiting flush), `prefs`. Answer and finish must name the `quizId`, so a stale retry can't land on a newer quiz (answer → 409 `not_current_quiz`; finish of an already-finished quiz → its stored result, `alreadyFinished: true`). The route assembles (it already holds the DB connection) and hands the snapshot to `start()`. Starting while a quiz is in progress → 409 `quiz_in_progress` with that quiz (resume, FR-18); the way out is finish, which may be early. Answers are strictly in order and idempotent by index (a repeat returns the stored answer, `duplicate: true`). Practice returns verdict + explanation per answer; Exam returns only the choice until finish; finish returns score + full review in both. `finish()` moves the quiz to `quiz:done:<quizId>`; the STM-10 flush (above) drains those and deletes each only after Postgres commits.

## Data model invariants

- `sources.content_hash` is **unique**. That constraint *is* the cache. Don't reimplement it in app code.
- `sources.visibility`: private to the uploader unless shared to the group. Questions from a private source are only served to people who uploaded the same file.
- `session_questions.question_snapshot` stores what the user actually saw. Never rely on the FK alone.
- `questions.difficulty` and `questions.format` are assigned **by the classifier at write time**, not by the generator. Quiz assembly is a plain filtered query with no model calls.
- `questions.payload` is jsonb with a per-format shape, validated by Zod.
- Three flags hide a question pending review.

## Generation pipeline (Workflow, each step durable)

Claim lock → Extract → Fingerprint (stop if the bank exists) → Classify (sample start/middle/end chunks, low confidence falls through to one model call) → Chunk (keep heading path + char range) → Generate (Zod-validate, retry once, then drop) → Tag → Filter (rubric score + vector near-dup) → Store (one transaction, mark ready, release lock). Target 20–25 questions. **Fewer than 5 survive → the job fails visibly.**

## User-facing messages (use these exact strings)

- No text extracted: "I could not read this file. Scanned PDFs are not supported yet."
- Off-topic: "This looks like {detected}. CreateMyQ only covers software engineering right now."
- Too few questions: the job fails and says the source was too thin.
- Daily cap: "You have hit today's limit. It resets at midnight."
- Spend ceiling crossed: generation is disabled and the message says why.

## Limits and targets

PDF ≤ 50 pages and ≤ 20 MB. Sign-in is a Clerk email code; a session lasts 7 days (fixed on Clerk's free plan). Quiz lengths 5/10/20. Exclude questions seen in the last 30 days until the pool is exhausted. Fallback (STM-8, one query in `worker/quiz/assemble.ts`): unseen questions first at random, then the least recently seen; "seen" = in one of the user's *finished* sessions; a pool smaller than the length returns all of it with `short: true`. Quiz start < 1 s, MC answer < 300 ms, cached source < 2 s, generation ~90 s typical. Cost < $15/month, < $0.15 per source.

## Security

- Every `/api` route requires a valid session except `GET /api/health`. New routes are protected by default (`PUBLIC` in `worker/auth/session.ts`).
- Sign-in is Clerk, email code only. The SPA sends the Clerk session token as `Authorization: Bearer …`; the Worker ignores the `__session` cookie and verifies the token networkless with the secret `CLERK_JWT_KEY` (JWKS public key, PEM) and `azp` = the request's origin. No `CLERK_SECRET_KEY` in the Worker. A missing key fails closed (500).
- Invite-only, two layers: Clerk runs in **Restricted** mode (strangers can't create accounts), and the `invites` table is the allowlist and the source of truth. The verified email comes from a custom session-token claim `{"email": "{{user.primary_email_address}}"}`; an email not in `invites` gets 403 `not_invited`. The `users` row is created on the first request (no webhooks).
- **Adding a person = an `invites` row + a Clerk user** (Dashboard → Users → Create user). Removing one = both too.
- This departs from the design doc's FR-2/FR-3 (magic link, 30-day cookie) by the user's decision (2026-09-28). `magic_links` and `auth_sessions` are unused.
- Users read only their own sessions, answers, preferences and private sources.
- Uploads go browser → R2 via short-lived signed URL, never through the API.
- Secrets: `wrangler secret put` in prod, `.dev.vars` locally (gitignored). Never commit secrets.

## Working agreement

- **One ticket per session. One branch, one PR, one merge.** Branch name: `stm-<n>-<short-slug>`.
- **Stay inside the ticket.** Don't build ahead. Bindings, tables and deps arrive with the ticket that needs them.
- **Where code goes.** Routes do HTTP only (parse with a schema from `schemas.ts`, call, respond with `c.json` or `apiError`). Rules are pure functions that take the time and ids as arguments (`session-state.ts`, `assemble.ts`, `flush.ts`) and get unit tests; Durable Object storage stays in the DO. Screens compose hooks (data and effects) and render; switches over unions end in `assertNever` / `satisfies never`.
- **Schema changes only in STM-4** or a ticket that explicitly says so.
- STM-8, STM-15 and STM-18 get a line-by-line human review. Keep those diffs small and obvious.
- STM-6 (the 20 seed questions) is written by the human, not Claude.
- UI: right/wrong is never shown by colour alone, tap targets are ≥ 44px, and reduced motion turns transitions off. Keyboard: number keys select, Enter submits.

## Definition of done (every ticket)

1. Acceptance criteria demonstrably met, **checked by running it**. "It should work" is not done.
2. `npm run typecheck`, `npm run lint` and `npm test` pass.
3. No secrets in the repo.
4. Errors surface as a handled message, never a stack trace in the UI (`app.onError` returns JSON; the UI renders a friendly message).
5. Merged to main and deployed.

After finishing a ticket, tick it in [TASKS.md](TASKS.md).

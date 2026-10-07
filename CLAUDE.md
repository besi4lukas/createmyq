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
npm run extract -- <file.pdf | url> [--out t.txt] [--chunks]  # STM-14: run extraction in Node and print chars, fingerprint, spans and a sample (writes nothing); --chunks also prints the STM-17 chunks
```

Migrations use the direct (unpooled) Neon URL, never Hyperdrive. Test them on a throwaway Neon branch first: `DATABASE_URL_UNPOOLED="$(neon connection-string <branch>)" npm run db:migrate`. pgvector is created by `drizzle/0000_enable_pgvector.sql` (drizzle-kit does not create extensions).

`db:seed` targets `SEED_DATABASE_URL` if set, else `DATABASE_URL_UNPOOLED` (shell, then `.env.local`), and prints the Neon endpoint id it is about to write to. It never changes `status` on an existing question (a flagged or retired question stays hidden), and never touches questions missing from the file. `--dry-run` runs the transaction and rolls it back.

### CI and deploy

`.github/workflows/ci.yml` runs typecheck, lint, test and build on every PR and push to main. A push to main (a merge) then runs `npm run deploy` with the wrangler version from `package-lock.json`. Deploys never overlap.

- GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`. Set them with `gh secret set <NAME>`.
- Runtime secrets for the Worker go through `npx wrangler secret put <NAME>`, never the repo or the CI config. Locally they live in `.dev.vars`.
- Always use `npx wrangler`, not a global `wrangler`.
- The queues `createmyq-generation` and `createmyq-generation-dlq` must exist before a deploy (`npx wrangler queues create <name>`), and `CLOUDFLARE_API_TOKEN` needs Queues and Workflows edit permissions on top of the template (STM-15).

## Layout

```
src/                  React app (browser only, never import from worker/)
src/index.css         the theme: every colour, type size, radius and shadow (Nocturne tokens, see "Frontend")
src/lib/              api.ts (fetch + Clerk token, ApiError, friendlyError), quiz.ts (typed quiz API, DIFFICULTIES/QUIZ_LENGTHS/MODES), results.ts (STM-12: verdictOf, scorePercent, headlineFor, topicBreakdown, summarize; pure, from review[]), router.ts (tiny History API router, linkTo), hooks: useAsync (load on mount), useMe (Clerk + /api/me), useSignOut
src/components/       our own small primitives (Button, Segmented, Tag, Toast, TopBar); shadcn copies go in src/components/ui/
src/screens/          one file per screen (Auth, Home, Setup, Quiz, Result): views that compose hooks
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
worker/durable/generation-lock.ts  GenerationLock DO (STM-16), one per content fingerprint via idFromName(fingerprint): claim / renew / release; exported from worker/index.ts
worker/quiz/flush.ts   STM-10: writeFinishedSession(), the one-transaction write of a finished quiz (called only by the DO)
worker/extract/        STM-14: extractSource() (index.ts) → Extracted {text, fingerprint, title, url, spans, meta} | ExtractFailure {code, message (user-facing), retryable}. normalise.ts + fingerprint.ts (pure), pdf.ts (unpdf), article.ts (linkedom + Readability), youtube.ts (InnerTube captions), source-url.ts (URL kinds, SSRF checks), safe-fetch.ts
worker/chunk/          STM-17: chunkSource({kind, text, title, spans}) → Chunk[] (index.ts: sections, split, join, page/time labels), headings.ts (heading detection per kind). Pure
worker/uploads/        STM-13: upload-rules.ts (pure: schemas, size/type checks, key `uploads/<users.id>/<sourceId>.pdf`, 5-min TTL), presign.ts (aws4fetch SigV4 presigned PUT, signs Content-Type + Content-Length), upload-routes.ts (POST /api/uploads, POST /api/uploads/complete, GET /api/uploads/:id)
worker/limits/         STM-24: daily-cap.ts (the per-user day window, reset time, cap message; pure), spend.ts (ceiling rules, month start, stableUuid; pure), spend-db.ts (monthSpendUsd, reserveRunSpend, recordRunSpend on model_calls)
worker/questions/payload.ts  Zod schemas for questions.payload per format; payloadByFormat + withFormatPayload(shape) is the one place a format joins the union
worker/testing/       test-only: cloudflare:workers stub (aliased in vitest.config.ts) and a fake DO state; *.test.ts sit next to the code
scripts/              operator scripts, run with tsx, type-checked by tsconfig.node.json (seed.ts, seed-file.ts, pg-fault-proxy.ts: dev-only flush fault injection, extract.ts; extract-harness/: dev-only Worker that runs extraction in workerd, never deployed)
worker/workflows/      STM-15: generation.ts (GenerationWorkflow: the pipeline's steps, retry configs, sources status writes), queue.ts (queue consumer: one run per source), rules.ts (pure: allowed status moves, instance id, step-result size cap, messages); STM-16: bank.ts (claimContentHash, reopenBank: the Postgres side of the fingerprint cache), lock-rules.ts (pure: lease, claim/renew/release, afterFingerprint, mayReopen); STM-18: generate.ts (pure: model, prompt, plan, checks, retry once, cap, cost), anthropic.ts (the one model call, through AI Gateway), store.ts (storeBank: one transaction); STM-19: filter.ts (pure: grader prompt + rubric, threshold, cosine, near-dup collapse, cap), embed.ts (Workers AI embeddings)
wrangler.jsonc        Worker config and bindings (bindings are added by the ticket that needs them)
worker-configuration.d.ts  generated by `wrangler types` (gives the global `Env` type)
worker/db/schema.ts   Drizzle schema (every Postgres table); client.ts gives withDb(env, ctx, db => …)
drizzle/              generated SQL migrations + meta (never edit an applied migration)
drizzle.config.ts     drizzle-kit config
tsconfig.*.json       app / worker / node projects, referenced from tsconfig.json
```

Expected additions as tickets land: more DOs in `worker/durable/`, `worker/classifier/`, `seed/` (question JSON), `scripts/` (operator scripts: seed, invite, cost report, benchmark), `fixtures/eval/` (gate eval set).

## Frontend (STM-11)

- Design source: the Claude Design handoff (Nocturne design system, "CreateMyQ Prototype"). Question layout C (Split), results layout B (Big number).
- **Tokens only.** `src/index.css` switches Tailwind's default palette, type scale, radii and shadows off (`--color-*: initial` etc.) and defines ours: `bg`, `surface`, `text`, `muted`, `label`, `accent`, `divider`, `wrong`/`wrong-bg`/`wrong-bd`, `neutral-100…900`, `accent-100…900`; `text-tag|meta|small|ui|body|title|h4|q|h2|h1|counter|score`; `rounded-sm|tag|badge|md|panel|tile|lg`; `shadow-sm|md|lg|selected`. No raw colours in components. No glows: elevation is a 1px edge plus a black ambient shadow, and the accent is a line, never a glow or flood. Light theme tokens exist under `[data-theme="light"]`; the switch arrives with the Preferences screen.
- Primary buttons are outlined, never filled. Headings max weight 500. Inter 400/500/600 self-hosted via `@fontsource/inter`; icons are `@phosphor-icons/react`.
- Choice controls are native radio inputs (`Segmented`, `OptionList`): keyboard and screen-reader behaviour for free, so no Radix yet.
- Motion: only an opacity fade on options and the checking dots; the reduced-motion guard in `index.css` turns every transition and animation off. Transitions and the reveal animation are STM-26.
- Routes: `/`, `/setup/<category>`, `/quiz`, `/results` (in memory only; a refresh goes home). `/quiz` always resumes from `GET /api/session`.
- Focus on a new screen: App focuses `<main>`, or the element marked `data-autofocus` inside it (the results heading). The quiz screen focuses its question itself.
- Results (STM-12, layout B): big percent (96px phone / 140px desktop), headline by score, "{c} of {n} right[, {k} not answered], {category}, {Difficulty}", a By topic table (topic → "x of y" + Solid / Getting there / Revisit), and every question with its verdict (icon + word: Correct / Not quite / Not answered), "You said", "Answer" when not correct, and the explanation. Everything is derived from the finish response's `review[]` during render (`src/lib/results.ts`); no API change. Unanswered questions count as not correct, as in the server's score. Actions: Another round, Home. "Review what I missed" is STM-25, the count-up STM-26.

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
Sync KV storage (`ctx.storage.kv`), every method synchronous, so nothing interleaves. Keys: `quiz:active` (at most one quiz in progress: full snapshot incl. answers, `answers[]` in order, public `quizId` and private `idempotencyKey` made at start), `quiz:done:<quizId>` (finished, awaiting flush), `prefs`, `gen:window` (STM-24 daily cap: `{ resetAt, timeZone, sourceIds }`). Answer and finish must name the `quizId`, so a stale retry can't land on a newer quiz (answer → 409 `not_current_quiz`; finish of an already-finished quiz → its stored result, `alreadyFinished: true`). The route assembles (it already holds the DB connection) and hands the snapshot to `start()`. Starting while a quiz is in progress → 409 `quiz_in_progress` with that quiz (resume, FR-18); the way out is finish, which may be early. Answers are strictly in order and idempotent by index (a repeat returns the stored answer, `duplicate: true`). Practice returns verdict + explanation per answer; Exam returns only the choice until finish; finish returns score + full review in both. `finish()` moves the quiz to `quiz:done:<quizId>`; the STM-10 flush (above) drains those and deletes each only after Postgres commits.

## Data model invariants

- `sources.content_hash` is **unique**. That constraint *is* the cache. Don't reimplement it in app code.
- `sources.visibility`: private to the uploader unless shared to the group. Questions from a private source are only served to people who uploaded the same file.
- `session_questions.question_snapshot` stores what the user actually saw. Never rely on the FK alone.
- `questions.difficulty` and `questions.format` are assigned **by the classifier at write time**, not by the generator. Quiz assembly is a plain filtered query with no model calls.
- `questions.payload` is jsonb with a per-format shape, validated by Zod.
- Three flags hide a question pending review.

## Generation pipeline (Workflow, each step durable)

Extract → Fingerprint (stop if the bank exists) → Claim lock (keyed by the fingerprint) → Classify (sample start/middle/end chunks, low confidence falls through to one model call) → Chunk (keep heading path + char range) → Generate (Zod-validate, retry once, then drop) → Tag → Filter (rubric score + vector near-dup) → Store (one transaction, mark ready, release lock). Target 20–25 questions. **Fewer than 5 survive → the job fails visibly.**

### The run (STM-15, `worker/workflows/`)
- **Trigger**: `POST /api/uploads/complete` sends `{ sourceId }` to the `createmyq-generation` queue while the source is `uploaded`. The consumer (`queue` handler in `worker/index.ts`) creates a `GenerationWorkflow` run with id `source-<sourceId>`; a redelivered message finds that run and is acked. Create failures retry 5 times, then go to `createmyq-generation-dlq` (nothing reads it yet). Article / YouTube intake routes don't exist yet; they will send the same message.
- **Steps**: start (`uploaded`→`processing`) → extract → fingerprint → claim lock → generation enabled → reserve spend → classify → chunk → generate chunk n (one per picked chunk, side by side) → grade → filter → record spend → store → release lock (plus `refund daily cap` on any end before reserve spend). Each is a named `step.do` with its own retry config. A step's return value is stored; an interrupted run resumes at the first step that has not returned. Every step must be safe to run twice. Classify is a stub with `TODO(STM-21/22)`.
- **Text between steps**: the Extract step's return value (`{ ok, text, fingerprint }`), never Postgres. Workflows caps a step result at 1 MiB, so text over 500,000 chars fails the source with `TOO_MUCH_TEXT`.
- **Status writes** go through `allowedFrom()` in `rules.ts`: `processing` only from `uploaded`/`processing`, `failed` only from `processing`, `duplicate` only from `processing`/`duplicate`, `ready` only from `processing`. So a stale run never overwrites a finished source. Any failure ends with `status = 'failed'` and a user-facing `error` (the extract message, `GENERATION_OFF`, `TOO_THIN`, or `GENERATION_FAILED` when a step ran out of retries), and the run ends as errored.
- **Logs** (ids only): `generation_run_created` / `generation_run_exists` / `generation_run_create_failed` (consumer); `generation_step_ok` / `generation_step_failed` with `step` and `attempt`, `generation_skipped`, `generation_run_failed` (Workflow); STM-16: `generation_bank_exists`, `generation_lock_not_ours` (with `reason` busy/finished and `heldBy`), `generation_write_skipped_lock_lost`, `generation_failed_without_lock` (Workflow), `generation_lock_claimed` (with `tookOverFrom` after an expired lease) / `_reclaimed` / `_busy` / `_renewed` / `_lost` / `_released` / `_release_noop` (GenerationLock, with `fingerprint` and `holder`).
- **Inspect a run**: `npx wrangler workflows instances describe createmyq-generation source-<sourceId>` (add `--local --port <vite port>` in dev), or the dashboard (Workers → Workflows). Locally, state persists in `.wrangler/state` across a dev-server restart, but miniflare does not re-drive a run that was killed mid-step. Pause and resume it (Local Explorer `PATCH …/workflows/createmyq-generation/instances/<id>/status`) and it continues at the interrupted step.

### Generate + store (STM-18, `generate.ts`, `anthropic.ts`, `store.ts`)
- **Kill switch**: `GENERATION_ENABLED` (var, `"false"` in `wrangler.jsonc`, `true` in `.dev.vars` to test). Anything but `"true"` fails the bank with `GENERATION_OFF` before any model call. The manual master switch; the spend ceiling (STM-24, below) is the automatic second gate.
- **Model**: `claude-sonnet-5-5` (`MODEL` in `generate.ts`, with its prices), extended thinking off (`between_tools`, Sonnet 5.5 only), effort medium, structured output (`RESPONSE_SCHEMA`), max 4,000 output tokens. Called with `@anthropic-ai/sdk` through AI Gateway: `AI_GATEWAY_URL` (var, gateway `createmyq`) + secret `ANTHROPIC_API_KEY`. The SDK retries 408/409/429/5xx/network twice, then the step retries twice (30 s, exponential); other 4xx are `NonRetryableError` (bad key, model or gateway), which fails the run with `GENERATION_FAILED`.
- **Plan**: at most 9 chunks, picked evenly (`planChunks`), asking `ceil(27 / n)` questions each (max 8). One step per chunk, so a resumed run never pays twice for a finished chunk.
- **Checks** (`parseReply`): the reply as a whole must be `end_turn` and JSON `{ questions: [...] }`, else it is retried once and then the chunk is dropped (`dropped` in the log). Each question must pass the Zod shape (strict: no extra keys, so the model can't set difficulty or format), `multipleChoicePayload`, and its `quote` must appear in the chunk (whitespace, curly quotes and dashes folded). Failing questions are dropped one by one (`rejected` counts). Nothing unchecked reaches the store step.
- **Filter**: see STM-19 below. Then the correct option is moved to position `i % 4` (`spreadAnswers`; models favour some positions). Fewer than 5 kept → `TOO_THIN`, nothing written.
- **Store** (one transaction, lock renewed first): bank `processing`→`ready` (matches nothing on a re-run, so nothing is written twice), the cited chunks into `source_chunks` (with their text), the questions with `origin 'generated'`, `format 'multiple_choice'` (what we asked for), `difficulty 'intermediate'` (`TODO(STM-23)`: the classifier assigns it), `status 'approved'`, `chunk_id` and `citation {headingPath, location, charStart, charEnd, quote}` (the range is the chunk's).
- **Logs**: `generation_chunk_done` (`chunkOrdinal`, `calls`, `usage`, `dropped`, `rejected`, `kept`) and `generation_run_summary` (`chunks`, `chunksAsked`, `chunksDropped`, `calls`, `generated`, `kept`, `inputTokens`, `outputTokens`, `costUsd`). No source text. AI Gateway logs every call too.
- **Not yet**: no way to take a quiz from a source's questions (STM-8 assembly is by category).

### Daily cap and spend ceiling (STM-24, `worker/limits/`)
- **Daily cap** (`DAILY_GENERATION_CAP` var, default 3): runs per user per day, in the user's `UserSession` (`gen:window`). The day is the user's own: the browser sends its IANA `timeZone` with `POST /api/uploads` and `/complete` (invalid or missing → UTC). Once a window opens, its `resetAt` (next local midnight, DST-safe) is fixed, so changing time zone mid-day doesn't reset it. `POST /api/uploads` only checks; `/complete` counts the upload by `sourceId` atomically with the check (a retried complete counts once; an existing source row is never re-counted). The Workflow gives the count back (`refund daily cap` step → `refundGeneration`) when the run ends without reserving spend: a duplicate of a finished bank, another run holding the lock, an unreadable file, the kill switch, the ceiling. So in effect the cap counts runs that reach a model. Refused → 429 `daily_cap` with `limit`, `resetAt`, `timeZone`; at complete the R2 object is deleted and no row or run is created.
- **Spend ceiling** (`SPEND_CEILING_USD` var, default 15): dollars per UTC calendar month across everyone, in Postgres `model_calls` (shared, so never a DO). The `reserve spend` step, before any model call, takes `pg_advisory_xact_lock` and inserts a `purpose 'reservation'` row of $0.20 (`RESERVE_PER_RUN_USD`) only if the month's sum (real rows + open reservations) plus it stays ≤ the ceiling; else the run fails with the ceiling message. Concurrent runs can't squeeze past it together. A run that reserved finishes. `record spend` (after `filter`) writes one row per generate step (`generate`, Sonnet tokens/cost), one `grade` (Haiku) and one `embed` (Workers AI, cost estimate only), with ids from `stableUuid(instanceId, label)` (`ON CONFLICT DO NOTHING`), and deletes the reservation in the same transaction. If any cost is unknown (a step needed a second attempt, or grading degraded) or the run fails after reserving, the reservation stays too: over-counting is safe. `POST /api/uploads` and `/complete` also check (read-only, `monthSpendUsd`) for a fast 503 `spend_ceiling`.
- **Order**: `GENERATION_ENABLED` (manual) → daily cap (per user) → spend ceiling (global). Setting `SPEND_CEILING_USD` to 0 stops new runs without a code change.
- **Spend this month**: `select sum(cost_usd) from model_calls where created_at >= date_trunc('month', now() at time zone 'utc')`. Rows have `user_id` (the uploader) and `source_id` (the upload whose run spent).
- **Logs**: `daily_cap_counted` (`sourceId`, `used`, `limit`), `spend_reserved` / `spend_ceiling_reached` (`spentUsd`, `ceilingUsd`), `spend_recorded` (`rows`, `recordedUsd`, `reservationReleased`).

### Quality filter (STM-19, `filter.ts`, `embed.ts`)
- **Grade** step: one `claude-haiku-4-5` call (`anthropicGrader`, same gateway and key, structured output `GRADER_RESPONSE_SCHEMA`, no thinking, max 6,000 tokens) grades every question with its passage on five criteria, each 0/1/2: `grounded`, `single_answer`, `distractors`, `understanding` (not trivia), `explanation`. `quality_score` = sum / 10. An unusable reply throws; the step retries once (30 s), so a run pays for at most two grading calls.
- **Rules**: dropped if `grounded`, `single_answer`, `understanding` or `explanation` is 0 (wrong, ambiguous, trivia, wrong explanation), or the score is below `MIN_QUALITY` 0.7. Distractors only lower the score.
- **Filter** step: embeds the passing questions (prompt + answer) with Workers AI `@cf/qwen/qwen3-embedding-0.6b` (1024 dims, `EMBEDDING_INSTRUCTION`, binding `AI`, `remote: true`: local dev calls Cloudflare and is billed), then collapses near-duplicates: best-scored first, a question at cosine ≥ `NEAR_DUPLICATE` 0.83 to one already kept is dropped. Then the cap: the 25 best-scored, kept in source order. Scope is the run only: a bank is only ever filled by one run (ready banks are never reopened, failed ones have no questions), and banks of different sources are served separately.
- **Stored**: `quality_score` and `embedding` (rounded to 6 decimals; the filter step result is ~250 KB). `rubric` is untouched (it is for short-answer expected points).
- **Degrades, never fails the run**: grading still failing on its last attempt (or a non-retryable 4xx) → every question kept unscored (`quality_score` null); embedding failing on its 3rd attempt → no near-dup check, `embedding` null. Both log `generation_filter_degraded` (`stage` grade/embed). A grade missing for one question leaves just that one unscored.
- **Logs**: `generation_filter_summary` (`generated`, `belowThreshold`, `nearDuplicate`, `capped`, `kept`, `graded`, `unscored`, `embedded`, grade tokens, `gradeCostUsd`, `embedCostUsd`); `generation_run_summary` adds `generationCostUsd`, `filterCostUsd` and the total `costUsd`. The `filter` step's result holds every question's decision (score, outcome, `duplicateOf`, `similarity`, the grader's note); notes are never logged.
- **Cost** (real runs, 2026-10-07): grading $0.015 (MapReduce) to $0.020 (Raft), embeddings ~$0.00002. Whole runs $0.115 and $0.137 per source.

### Fingerprint cache + generation lock (STM-16)
Two things decide who does the work for a piece of content, and they never overlap:
- **Which source is the bank: Postgres.** The fingerprint step writes `content_hash` on the run's own source (`bank.ts: claimContentHash`). The UNIQUE constraint picks the winner; no app code checks first. On the unique violation (`23505`, `sources_content_hash_unique`) the source becomes `duplicate` with `duplicate_of_id` → the owner (the bank), and in the same transaction its `source_uploads` rows are copied onto the bank, so the private-source rule serves the bank's questions to that uploader too. The bank row never changes; every uploader of the same text is linked to it. A duplicate's own R2 object and row are kept.
- **Which run fills the bank: the `GenerationLock` DO** (one per fingerprint, `idFromName(fingerprint)`, key `lock` = `{holder, claimedAt, leaseUntil}`, holder = the run's own sourceId). Only asked when the bank is not finished. Sync KV, so two claims can't interleave. A repeat claim by the holder extends the lease (step retry). The lease is 15 min (`LEASE_MS`); an expired one is taken over lazily by the next claim (no alarm). The holder calls `renew` before each bank write (store, mark failed); a run that lost the lock gets `renewed: false` and writes nothing. `release` only by the holder, after store and after mark failed. Generation never runs in the DO.
- **After the fingerprint** (`lock-rules.ts`): bank `ready` or `refused` → stop, the upload shares it (no lock asked). Otherwise claim. Not granted → stop (`waiting_on_other_run`); the holder finishes the bank for everyone. Granted → `reopenBank` moves the bank to `processing` if `mayReopen`: `uploaded`/`processing` yes; `failed` only if it failed *before this run's source was uploaded* (a re-upload retries a failure, an upload that raced the failing run shares its outcome); otherwise release and stop. From then on the run writes to the bank, not to its own source.
- **Failure path**: before the fingerprint, mark the run's own source failed (as STM-15). While holding the lock, mark the bank failed (renewed first) and release. Between fingerprint and lock (the lock step ran out of retries), write nothing (`generation_failed_without_lock`); a re-upload can claim it.
- **The user's view**: `GET /api/uploads/:id` (and `complete`) report a duplicate's *bank* status, plus `bankSourceId`. The bank is reachable by every uploader via `source_uploads`; another user's duplicate row is not.
- **Inspect**: `select id, status, duplicate_of_id, content_hash from sources where id = '<id>' or duplicate_of_id = '<id>'`; who can reach a bank: `select user_id from source_uploads where source_id = '<bank id>'`. The lock state is only in the DO; the `generation_lock_*` logs say who held it.
- Not handled: a waiter does not wait. If the holder dies, its bank stays `processing` until the lease runs out and someone uploads the same text again. Reopening a `failed` bank keeps its `source_uploads`, so its first uploader gets the retry's questions too.

### Extract + Fingerprint (STM-14, `worker/extract/`)
Plain functions the Workflow will call; they never touch Postgres. Input: the PDF's bytes (the Workflow reads R2) or the row's `url`. Same code runs in workerd and Node (no Workers-only globals).
- **Normalise** (`normaliseText`, pure, idempotent): NFC, ligatures spelled out, `\n` line endings, invisible/control chars dropped, all spaces → one space, de-hyphenation (`lowercase-⏎lowercase` joins), lines trimmed, at most one blank line. **Fingerprint** = `"v1:" + sha256(lowercase, whitespace-collapsed normalised text)`. Changing either rule changes every hash: bump `FINGERPRINT_VERSION`. Writing it to `content_hash` (and the duplicate path) is STM-16, below.
- **PDF**: > 20 MB → upload message; > 50 pages → "This PDF has N pages. The limit is 50."; < 200 letters, or < 25 letters/page → the scanned-PDF message. Running headers/footers and page numbers are dropped (pages of 10+ lines only); `spans` are page ranges ("p. 3").
- **Article**: http(s) only, default ports, no credentials, no localhost/private/link-local IP literals, re-checked on every redirect (max 5); 15 s, 5 MB. Readability picks the main text; headings become `## …`. Under 300 letters → "I couldn't find an article on that page."
- **YouTube** (fragile, undocumented): InnerTube `/youtubei/v1/player` as the ANDROID client (no key, no OAuth; its caption URLs need no PO token), English uploaded captions before auto, srv3 XML → paragraphs with `m:ss` spans. Verified from Cloudflare's network 2026-10-05. Blocks/429/empty bodies → `youtube_blocked` (retryable); if it breaks, the client name/version in `youtube.ts` is the first thing to change.

### Chunk (STM-17, `worker/chunk/`)
Pure and deterministic; the Workflow's chunk step returns `chunkSource(...)`. `Chunk = { ordinal, start, end, headingPath: string[], location: string | null }`, matching `source_chunks` (`ordinal`, `char_start`/`char_end`, `heading_path`). The Extract step returns `title` and `spans` too, for the chunker. **Ranges, not text**: later steps take `text.slice(start, end)` from the Extract step's result (chunks of a 90k-char paper are ~3.5 KB).
- **Ranges** are trimmed and in order; the gaps between them are whitespace only, so every non-whitespace char is in exactly one chunk.
- **Sizes**: target 4,000 chars, max 6,000, min 1,200. A section over the max is cut into near-equal pieces at the best break near each cut: blank line > sentence end > line break > space (never mid-word unless a 6,000-char run has no space). A piece under the min joins the next (else the previous) within the max, keeping the headings both share; **two parts that share no heading stay apart** (a citation must be true of the whole chunk), except the untitled opening, which joins the first section. So short top-level sections (Acknowledgements, a 1,000-char Conclusion) can be short chunks.
- **Headings**: article `#…######` lines standing alone between blank lines, nested by level. PDF (no font info): numbered section lines (`3.1 Execution Overview`; `1. INTRODUCTION` only in ALL CAPS, so numbered list items don't count) whose number follows the previous heading (child, next sibling, or one skipped), plus lines that are exactly Abstract / Introduction / Background / Related work / Conclusion(s) / Summary / Acknowledg(e)ments / References / Bibliography / Appendix …. A heading wrapped onto two lines keeps only its first line. YouTube: none.
- **Path fallback**: text before the first heading, and sources with no headings, get `[title]` (tool-generated PDF titles like "Microsoft Word - x.doc" are ignored → `[]`).
- **location**: PDF `"p. 4"` / `"pp. 4–5"`, YouTube `"3:05–7:40"` (ends where the next caption paragraph starts; the last chunk ends at its last paragraph's start), article `null`.

## User-facing messages (use these exact strings)

- No text extracted: "I could not read this file. Scanned PDFs are not supported yet."
- Off-topic: "This looks like {detected}. CreateMyQ only covers software engineering right now."
- Too few questions: "This source was too thin to make a quiz from. Try a longer or more detailed one."
- Generation switched off (`GENERATION_ENABLED`): "Making quizzes from your own files is switched off for now."
- Daily cap: "You have hit today's limit. It resets at midnight." followed by the reset time, e.g. " That's in 5 h 42 min (Thu 8 Oct, 00:00 CDT)." (`capMessage`).
- Spend ceiling crossed (upload refused, or a queued run stopped): "New quizzes from your own files are paused until next month: CreateMyQ has reached its monthly spending limit. Built-in categories still work."

## Limits and targets

PDF ≤ 50 pages and ≤ 20 MB. Sign-in is a Clerk email code; a session lasts 7 days (fixed on Clerk's free plan). Quiz lengths 5/10/20. Exclude questions seen in the last 30 days until the pool is exhausted. Fallback (STM-8, one query in `worker/quiz/assemble.ts`): unseen questions first at random, then the least recently seen; "seen" = in one of the user's *finished* sessions; a pool smaller than the length returns all of it with `short: true`. Quiz start < 1 s, MC answer < 300 ms, cached source < 2 s, generation ~90 s typical. Cost < $15/month (`SPEND_CEILING_USD`), < $0.15 per source. At most 3 generation runs per user per day (`DAILY_GENERATION_CAP`).

## Security

- Every `/api` route requires a valid session except `GET /api/health`. New routes are protected by default (`PUBLIC` in `worker/auth/session.ts`).
- Sign-in is Clerk, email code only. The SPA sends the Clerk session token as `Authorization: Bearer …`; the Worker ignores the `__session` cookie and verifies the token networkless with the secret `CLERK_JWT_KEY` (JWKS public key, PEM) and `azp` = the request's origin. No `CLERK_SECRET_KEY` in the Worker. A missing key fails closed (500).
- Invite-only, two layers: Clerk runs in **Restricted** mode (strangers can't create accounts), and the `invites` table is the allowlist and the source of truth. The verified email comes from a custom session-token claim `{"email": "{{user.primary_email_address}}"}`; an email not in `invites` gets 403 `not_invited`. The `users` row is created on the first request (no webhooks).
- **Adding a person = an `invites` row + a Clerk user** (Dashboard → Users → Create user). Removing one = both too.
- This departs from the design doc's FR-2/FR-3 (magic link, 30-day cookie) by the user's decision (2026-09-28). `magic_links` and `auth_sessions` are unused.
- Users read only their own sessions, answers, preferences and private sources.
- Uploads go browser → R2 via short-lived signed URL, never through the API.
  How STM-13 does it: `POST /api/uploads {filename,size,contentType}` rejects non-PDF (400 `not_pdf`) and > 20 MB (413 `too_large`) before signing, then returns `{sourceId, uploadUrl, headers, expiresAt}`. No row yet. The browser PUTs to R2 (S3 endpoint, URL valid 5 min, signature binds Content-Type and Content-Length). `POST /api/uploads/complete {sourceId, filename}` HEADs the object through the `UPLOADS` binding, re-checks type/size (deletes a bad object), and inserts the `sources` row (`status 'uploaded'`, `kind 'pdf'`, private, `content_hash` null) + its `source_uploads` row, idempotently. The key is built from the session's users.id, so another user's sourceId is a 404.
  R2 setup: bucket `createmyq-uploads` (prod) and `createmyq-uploads-dev` (local dev; the binding is `remote: true` with `preview_bucket_name`). Secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (an R2 API token, Object Read & Write on both buckets); `.dev.vars` also sets `UPLOADS_BUCKET_NAME=createmyq-uploads-dev`. Each bucket's CORS allows `PUT` with header `Content-Type` from the app origin(s) (`http://localhost:5173` for dev, the workers.dev origin for prod).
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

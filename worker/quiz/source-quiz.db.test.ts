/**
 * A quiz on one of the user's own sources, against real SQL (PGlite with the
 * repo's migrations): assembly (source-quiz.ts), the start route
 * (session-routes.ts, with the UserSession stubbed by the pure session rules)
 * and the flush (flush.ts: kind "source", the bank's source_id, finish twice =
 * one row).
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../auth/session";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { withQueryCache } from "../testing/query-cache";
import { writeFinishedSession } from "./flush";
import { sessionRoutes } from "./session-routes";
import { newQuiz, scoreQuiz, toPublicQuiz, type Quiz, type StartInput } from "./session-state";
import { pickSourceQuestions } from "./source-quiz";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const BANK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DUP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WORKING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let pg: PGlite;
let db: Db;

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await migrate(drizzle({ client: pg, schema }), { migrationsFolder: "drizzle" });
  db = drizzle({ client: withQueryCache(pg).client, schema }) as unknown as Db;
}, 60_000);
afterAll(() => pg.close());

/** `n` approved MC questions at `difficulty` in `sourceId`, prompts `${tag}1…`. */
async function addQuestions(sourceId: string, difficulty: string, n: number, tag: string) {
  await pg.query(
    `insert into questions (source_id, origin, format, difficulty, topic, prompt, explanation, payload)
     select $1, 'generated', 'multiple_choice', $2, 'topic', $3 || g, 'because', '{"options":["a","b","c","d"],"answer":"a"}'::jsonb
     from generate_series(1, $4::int) g`,
    [sourceId, difficulty, tag, n],
  );
}

beforeEach(async () => {
  await pg.exec(`truncate invites, users, sources, questions, sessions cascade;
    insert into invites (email) values ('a@x.test'), ('b@x.test');
    insert into users (id, email) values ('${U1}', 'a@x.test'), ('${U2}', 'b@x.test');
    -- U1's ready bank; U2 uploaded the same text later (a duplicate of it, STM-16)
    insert into sources (id, owner_id, kind, url, title, status, content_hash)
      values ('${BANK}', '${U1}', 'article', 'https://x.test/a', 'Replication', 'ready', 'h1');
    insert into sources (id, owner_id, kind, url, title, status, duplicate_of_id)
      values ('${DUP}', '${U2}', 'article', 'https://x.test/a', 'x.test/a', 'duplicate', '${BANK}');
    -- U2's private source, never uploaded by U1; U1's source still working
    insert into sources (id, owner_id, kind, title, status, content_hash) values ('${OTHER}', '${U2}', 'pdf', 'Theirs', 'ready', 'h2');
    insert into sources (id, owner_id, kind, title, status) values ('${WORKING}', '${U1}', 'pdf', 'Working', 'processing');
    insert into source_uploads (user_id, source_id) values
      ('${U1}', '${BANK}'), ('${U2}', '${DUP}'), ('${U2}', '${BANK}'), ('${U2}', '${OTHER}'), ('${U1}', '${WORKING}');`);
  await addQuestions(BANK, "beginner", 6, "b");
  await addQuestions(BANK, "advanced", 2, "a");
  await addQuestions(OTHER, "beginner", 6, "o");
  await pg.exec(`update questions set status = 'pending_review' where prompt = 'b6'`);
});

const prompts = (qs: { prompt: string }[]) => qs.map((q) => q.prompt).sort();

describe("pickSourceQuestions", () => {
  it("serves the source's approved questions at the chosen difficulty only", async () => {
    const out = await pickSourceQuestions(db, U1, { sourceId: BANK, difficulty: "beginner", length: 10 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out).toMatchObject({ bankSourceId: BANK, title: "Replication" });
    // b6 is hidden pending review; a short pool comes back whole (5 < 10).
    expect(prompts(out.questions)).toEqual(["b1", "b2", "b3", "b4", "b5"]);
    const five = await pickSourceQuestions(db, U1, { sourceId: BANK, difficulty: "beginner", length: 5 });
    expect(five.ok && five.questions).toHaveLength(5);
  });

  it("a duplicate gets its bank's questions (STM-16)", async () => {
    const out = await pickSourceQuestions(db, U2, { sourceId: DUP, difficulty: "advanced", length: 5 });
    expect(out.ok && { bank: out.bankSourceId, prompts: prompts(out.questions) }).toEqual({ bank: BANK, prompts: ["a1", "a2"] });
  });

  it("someone else's private source is not found; a working one is not ready; an empty level says so", async () => {
    expect(await pickSourceQuestions(db, U1, { sourceId: OTHER, difficulty: "beginner", length: 5 })).toMatchObject({
      ok: false,
      status: 404,
      code: "source_not_found",
    });
    expect(await pickSourceQuestions(db, U1, { sourceId: WORKING, difficulty: "beginner", length: 5 })).toMatchObject({
      ok: false,
      status: 409,
      code: "source_not_ready",
    });
    expect(await pickSourceQuestions(db, U1, { sourceId: BANK, difficulty: "intermediate", length: 5 })).toMatchObject({
      ok: false,
      status: 404,
      code: "no_questions",
      error: "This source has no intermediate questions. Try another difficulty.",
    });
  });

  it("questions seen in a finished session come last", async () => {
    const first = await pickSourceQuestions(db, U1, { sourceId: BANK, difficulty: "beginner", length: 5 });
    if (!first.ok) throw new Error("expected questions");
    const seen = first.questions.slice(0, 3);
    const quiz = finished(start({ questions: seen }));
    await writeFinishedSession(db, U1, quiz);
    const next = await pickSourceQuestions(db, U1, { sourceId: BANK, difficulty: "beginner", length: 2 });
    expect(next.ok && prompts(next.questions)).toEqual(prompts(first.questions.slice(3)));
  });
});

function start(over: Partial<StartInput> = {}): Quiz {
  const input: StartInput = {
    kind: "source",
    userId: U1,
    categoryId: null,
    category: null,
    sourceId: BANK,
    sourceTitle: "Replication",
    difficulty: "beginner",
    mode: "practice",
    length: 5,
    questions: [],
    ...over,
  };
  return newQuiz(input, { quizId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }, new Date().toISOString());
}
const finished = (q: Quiz) => scoreQuiz(q, new Date(Date.parse(q.startedAt) + 60_000).toISOString());

describe("flush of a source quiz", () => {
  it("writes one sessions row with kind 'source' and the bank's source_id, however often it is flushed", async () => {
    const picked = await pickSourceQuestions(db, U2, { sourceId: DUP, difficulty: "advanced", length: 5 });
    if (!picked.ok) throw new Error("expected questions");
    const quiz = start({ userId: U2, sourceId: picked.bankSourceId, difficulty: "advanced", questions: picked.questions });
    quiz.answers.push({ option: 0, choice: "a", correct: true, answeredAt: new Date().toISOString() });
    const done = finished(quiz);
    expect(await writeFinishedSession(db, U2, done)).toBe(true);
    expect(await writeFinishedSession(db, U2, done)).toBe(false);
    const { rows } = await pg.query<{ kind: string; source_id: string; category_id: string | null; difficulty: string; score: number }>(
      `select kind, source_id, category_id, difficulty, score from sessions`,
    );
    expect(rows).toEqual([{ kind: "source", source_id: BANK, category_id: null, difficulty: "advanced", score: 1 }]);
    const sq = await pg.query<{ n: number }>(`select count(*)::int as n from session_questions`);
    expect(sq.rows[0]!.n).toBe(2);
  });

  it("a quiz stored before source quizzes existed (no sourceId field) still writes, with a null source_id", async () => {
    const picked = await pickSourceQuestions(db, U1, { sourceId: BANK, difficulty: "beginner", length: 1 });
    if (!picked.ok) throw new Error("expected questions");
    const quiz = start({ kind: "category", questions: picked.questions });
    delete quiz.sourceId;
    delete quiz.sourceTitle;
    expect(await writeFinishedSession(db, U1, finished(quiz))).toBe(true);
    const { rows } = await pg.query<{ source_id: string | null }>(`select source_id from sessions`);
    expect(rows).toEqual([{ source_id: null }]);
  });
});

describe("POST /api/session { kind: 'source' }", () => {
  let started: StartInput[];
  const stub = {
    getActive: () => null,
    start: (input: StartInput) => {
      started.push(input);
      return { started: true, quiz: toPublicQuiz(newQuiz(input, { quizId: crypto.randomUUID(), idempotencyKey: "k" }, "2026-10-09T00:00:00Z")) };
    },
  };
  const post = async (userId: string, body: unknown) => {
    const app = new Hono<AppEnv>()
      .basePath("/api")
      .use(async (c, next) => {
        c.set("user", { id: userId, email: "a@x.test" });
        c.set("db", db);
        await next();
      })
      .route("/", sessionRoutes);
    const env = { USER_SESSION: { idFromName: (n: string) => n, get: () => stub } } as unknown as Env;
    const res = await app.request(
      "/api/session",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      env,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  beforeEach(() => {
    started = [];
  });

  it("starts a source quiz on the bank, named after the source", async () => {
    const res = await post(U2, { kind: "source", sourceId: DUP, difficulty: "advanced", length: 5, mode: "exam" });
    expect(res.status).toBe(201);
    expect(res.body.quiz).toMatchObject({
      kind: "source",
      category: null,
      sourceId: BANK,
      sourceTitle: "x.test/a",
      difficulty: "advanced",
      mode: "exam",
      length: 5,
      questionCount: 2,
    });
    expect(started[0]).toMatchObject({ kind: "source", userId: U2, categoryId: null, sourceId: BANK });
  });

  it("refuses with the reason when it can't", async () => {
    const res = await post(U1, { kind: "source", sourceId: OTHER, difficulty: "beginner", length: 5, mode: "practice" });
    expect(res).toMatchObject({ status: 404, body: { code: "source_not_found" } });
    const level = await post(U1, { kind: "source", sourceId: BANK, difficulty: "intermediate", length: 5, mode: "practice" });
    expect(level).toMatchObject({ status: 404, body: { code: "no_questions" } });
    expect(started).toEqual([]);
  });
});

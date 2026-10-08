/**
 * STM-25 against real SQL: the flush transaction (worker/quiz/flush.ts) writing
 * misses, and the review assembly (worker/quiz/review.ts). Postgres here is
 * PGlite (Postgres compiled to WASM, in process) with the repo's migrations
 * applied, so no network and no Neon branch: still `npm test` only.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import type { AssembledQuestion } from "./assemble";
import { writeFinishedSession } from "./flush";
import { assembleReview, countReview } from "./review";
import type { FinishedQuiz } from "./session-state";

let pg: PGlite;
let db: Db;
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const CAT = "44444444-4444-4444-8444-444444444444";
const qid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const question = (n: number): AssembledQuestion => ({
  id: qid(n),
  format: "multiple_choice",
  difficulty: "beginner",
  topic: `t${n}`,
  prompt: `p${n}`,
  explanation: `e${n}`,
  payload: { options: ["a", "b", "c", "d"], answer: "a" },
});

let clock = Date.UTC(2026, 9, 7, 12);
/** A finished quiz over questions `ns`; `verdicts[i]` true/false = right/wrong, missing = unanswered. */
function quiz(userId: string, ns: number[], verdicts: boolean[], kind: "category" | "review" = "category"): FinishedQuiz {
  const start = (clock += 60_000);
  const finishedAt = new Date((clock += 60_000)).toISOString();
  return {
    quizId: crypto.randomUUID(),
    userId,
    idempotencyKey: crypto.randomUUID(),
    kind,
    categoryId: null,
    category: kind === "review" ? null : "system-design",
    difficulty: kind === "review" ? null : "beginner",
    mode: "practice",
    length: ns.length,
    startedAt: new Date(start).toISOString(),
    finishedAt,
    score: verdicts.filter(Boolean).length,
    questions: ns.map(question),
    answers: verdicts.map((correct, i) => ({
      option: correct ? 0 : 1,
      choice: correct ? "a" : "b",
      correct,
      answeredAt: new Date(start + 1_000 * (i + 1)).toISOString(),
    })),
  };
}

const missRows = async (userId: string) =>
  (
    await db.execute<{ question_id: string; correct_streak: number; resolved: boolean }>(sql`
      select question_id, correct_streak, resolved_at is not null as resolved
      from misses where user_id = ${userId} order by question_id`)
  ).rows;
const reviewIds = async (userId: string) => (await assembleReview(db, userId, 20)).map((q) => q.id).sort();

beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  const d = drizzle({ client: pg, schema });
  await migrate(d, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  db = d as unknown as Db; // same query-builder surface as node-postgres for what is used here
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  await db.execute(sql`truncate invites, users, categories, questions, sources cascade`);
  await db.execute(sql`insert into invites (email) values ('a@x.test'), ('b@x.test')`);
  await db.execute(sql`insert into users (id, email) values (${U1}, 'a@x.test'), (${U2}, 'b@x.test')`);
  await db.execute(sql`insert into categories (id, slug, name, niche) values (${CAT}, 'system-design', 'System Design', 'se')`);
  for (let n = 1; n <= 6; n++) {
    await db.execute(sql`
      insert into questions (id, category_id, origin, format, difficulty, topic, prompt, explanation, payload)
      values (${qid(n)}, ${CAT}, 'seed', 'multiple_choice', 'beginner', ${`t${n}`}, ${`p${n}`}, ${`e${n}`},
              ${JSON.stringify(question(n).payload)}::jsonb)`);
  }
});

describe("misses written by the flush", () => {
  it("records wrong and unanswered questions, not correct ones; review serves exactly those", async () => {
    // q1 right, q2 wrong, q3 and q4 unanswered (finished early)
    expect(await writeFinishedSession(db, U1, quiz(U1, [1, 2, 3, 4], [true, false]))).toBe(true);
    expect(await missRows(U1)).toEqual([
      { question_id: qid(2), correct_streak: 0, resolved: false },
      { question_id: qid(3), correct_streak: 0, resolved: false },
      { question_id: qid(4), correct_streak: 0, resolved: false },
    ]);
    expect(await reviewIds(U1)).toEqual([qid(2), qid(3), qid(4)]);
    expect(await countReview(db, U1)).toBe(3);
    // Another user's misses are theirs alone.
    expect(await reviewIds(U2)).toEqual([]);
    expect(await countReview(db, U2)).toBe(0);
  });

  it("a repeated flush (finish twice, alarm retry) writes one session and never double counts a streak", async () => {
    await writeFinishedSession(db, U1, quiz(U1, [2], [false]));
    const review = quiz(U1, [2], [true], "review");
    expect(await writeFinishedSession(db, U1, review)).toBe(true);
    expect(await writeFinishedSession(db, U1, review)).toBe(false);
    expect(await writeFinishedSession(db, U1, review)).toBe(false);
    const { rows } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from sessions where idempotency_key = ${review.idempotencyKey}`,
    );
    expect(rows[0]!.n).toBe(1);
    expect(await missRows(U1)).toEqual([{ question_id: qid(2), correct_streak: 1, resolved: false }]);
  });

  it("two correct answers in a row resolve it (any quiz kind); resolved misses leave the review", async () => {
    await writeFinishedSession(db, U1, quiz(U1, [2, 3], [false, false]));
    await writeFinishedSession(db, U1, quiz(U1, [2, 3], [true, true], "review"));
    await writeFinishedSession(db, U1, quiz(U1, [2], [true])); // a category quiz counts too
    expect(await missRows(U1)).toEqual([
      { question_id: qid(2), correct_streak: 2, resolved: true },
      { question_id: qid(3), correct_streak: 1, resolved: false },
    ]);
    expect(await reviewIds(U1)).toEqual([qid(3)]);
  });

  it("a wrong answer resets the streak; missing a resolved question re-opens it", async () => {
    await writeFinishedSession(db, U1, quiz(U1, [2, 3], [false, false]));
    await writeFinishedSession(db, U1, quiz(U1, [2, 3], [true, true], "review"));
    await writeFinishedSession(db, U1, quiz(U1, [2, 3], [true, false], "review"));
    expect(await missRows(U1)).toEqual([
      { question_id: qid(2), correct_streak: 2, resolved: true },
      { question_id: qid(3), correct_streak: 0, resolved: false },
    ]);
    await writeFinishedSession(db, U1, quiz(U1, [2], [false]));
    expect(await missRows(U1)).toEqual([
      { question_id: qid(2), correct_streak: 0, resolved: false },
      { question_id: qid(3), correct_streak: 0, resolved: false },
    ]);
  });

  it("is order independent: a session flushed late (alarm retry) still lands in finish order", async () => {
    await writeFinishedSession(db, U1, quiz(U1, [2], [false]));
    const earlier = quiz(U1, [2], [true], "review"); // finished first, flush failed
    const later = quiz(U1, [2], [true], "review");
    await writeFinishedSession(db, U1, later);
    await writeFinishedSession(db, U1, earlier);
    expect(await missRows(U1)).toEqual([{ question_id: qid(2), correct_streak: 2, resolved: true }]);
  });

  it("a failure in the misses step is rolled back to its savepoint and the session still commits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await db.execute(sql`alter table misses add constraint test_break check (correct_streak < 0) not valid`);
    try {
      const q = quiz(U1, [2], [false]);
      expect(await writeFinishedSession(db, U1, q)).toBe(true);
      const { rows } = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from sessions where idempotency_key = ${q.idempotencyKey}`,
      );
      expect(rows[0]!.n).toBe(1);
      expect(await missRows(U1)).toEqual([]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("misses_refresh_failed"));
    } finally {
      await db.execute(sql`alter table misses drop constraint test_break`);
    }
  });
});

describe("review assembly", () => {
  it("skips hidden questions and private sources the user did not upload, oldest miss first, up to length", async () => {
    await writeFinishedSession(db, U1, quiz(U1, [1], [false]));
    await writeFinishedSession(db, U1, quiz(U1, [2, 3, 4], [false, false, false]));
    await db.execute(sql`update questions set status = 'pending_review' where id = ${qid(3)}`);
    await db.execute(sql`insert into sources (id, kind, visibility, owner_id) values
      ('33333333-3333-4333-8333-333333333333', 'pdf', 'private', ${U2})`);
    await db.execute(sql`update questions set source_id = '33333333-3333-4333-8333-333333333333' where id = ${qid(4)}`);

    expect(await countReview(db, U1)).toBe(2);
    expect((await assembleReview(db, U1, 5)).map((q) => q.id)).toEqual([qid(1), qid(2)]);
    expect((await assembleReview(db, U1, 1)).map((q) => q.id)).toEqual([qid(1)]);

    // Uploading the same file makes it servable again.
    await db.execute(sql`insert into source_uploads (user_id, source_id) values (${U1}, '33333333-3333-4333-8333-333333333333')`);
    expect(await reviewIds(U1)).toEqual([qid(1), qid(2), qid(4)]);
  });
});

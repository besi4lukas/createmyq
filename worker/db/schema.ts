/**
 * Postgres schema (STM-4). The shape comes from the design tab's "Data model"
 * section; comments mark every column added beyond it and why.
 *
 * Rules this file encodes (see CLAUDE.md):
 * - `sources.content_hash` is UNIQUE. That constraint is the cache.
 * - `session_questions.question_snapshot` stores what the user saw. The FK is
 *   only a convenience and goes null if the question is ever deleted.
 * - `questions.difficulty` / `format` are enums set by the classifier at write
 *   time, so quiz assembly is a plain filtered query.
 * - `questions.payload` is jsonb with a per-format shape, validated by Zod in
 *   application code, not here.
 * - `sessions.idempotency_key` is UNIQUE, so a repeated DO flush inserts once.
 *
 * Schema changes only happen in STM-4 or a ticket that explicitly says so.
 */
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * pgvector column with no fixed dimension. The embedding model is picked in
 * STM-19; a dimensionless column lets that ticket choose without a schema
 * change. At this app's scale (thousands of rows) an exact scan is fast enough,
 * so there is no ANN index yet. The `vector` extension is created by the first
 * migration (0000_enable_pgvector.sql).
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => value.slice(1, -1).split(",").map(Number),
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sourceVisibility = pgEnum("source_visibility", ["private", "group"]);
export const sourceKind = pgEnum("source_kind", ["pdf", "article", "youtube"]);
/**
 * uploaded   row created by the upload path (STM-13), content not read yet
 * processing the Workflow is running (extract … store)
 * ready      the bank exists and can be served
 * refused    the subject gate said no (detected_niche / reason say why)
 * failed     extraction failed, too few questions survived, etc. (`error`)
 * duplicate  fingerprint matched an existing source; see `duplicate_of_id`
 */
export const sourceStatus = pgEnum("source_status", [
  "uploaded",
  "processing",
  "ready",
  "refused",
  "failed",
  "duplicate",
]);
export const gateVerdict = pgEnum("gate_verdict", ["accepted", "refused"]);
export const questionFormat = pgEnum("question_format", ["multiple_choice", "short_answer"]);
export const questionDifficulty = pgEnum("question_difficulty", [
  "beginner",
  "intermediate",
  "advanced",
]);
/**
 * approved        servable
 * pending_review  hidden: three flags, or held for the operator to look at
 * retired         hidden for good (kept so old snapshots and misses still resolve)
 */
export const questionStatus = pgEnum("question_status", [
  "approved",
  "pending_review",
  "retired",
]);
export const questionOrigin = pgEnum("question_origin", ["seed", "generated"]);
export const sessionKind = pgEnum("session_kind", ["category", "source", "review"]);
export const sessionMode = pgEnum("session_mode", ["practice", "exam"]);
export const answerVerdict = pgEnum("answer_verdict", ["correct", "partial", "incorrect"]);
/** Whether code, the classifier (Jev) or a model decided the verdict. */
export const gradedBy = pgEnum("graded_by", ["code", "classifier", "model"]);

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** The invite list. The whole access control system. Emails stored lowercased. */
export const invites = pgTable(
  "invites",
  {
    email: text("email").primaryKey(),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [check("invites_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // FK to invites: a user cannot exist without being on the invite list.
    // Revoking an invite means deleting the user first (restrict).
    email: text("email")
      .notNull()
      .unique()
      .references(() => invites.email, { onDelete: "restrict", onUpdate: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [check("users_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

/**
 * Added for STM-5 (not on the design tab): magic-link tokens. Only a hash of
 * the token is stored. 15-minute expiry, single use via `used_at`.
 */
export const magicLinks = pgTable(
  "magic_links",
  {
    tokenHash: text("token_hash").primaryKey(),
    email: text("email").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("magic_links_email_idx").on(t.email, t.createdAt)],
);

/**
 * Added for STM-5 (not on the design tab): sign-in sessions behind the 30-day
 * cookie. Named `auth_sessions` because `sessions` is the quiz record. Only a
 * hash of the cookie token is stored. Sign out deletes the row (FR-3).
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Question bank
// ---------------------------------------------------------------------------

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  niche: text("niche").notNull(),
  createdAt: createdAt(),
});

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Set null on account deletion: the bank stays, the link to the person goes.
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    visibility: sourceVisibility("visibility").notNull().default("private"),
    kind: sourceKind("kind").notNull(),
    r2Key: text("r2_key").unique(), // pdf only
    url: text("url"), // article / youtube only (added)
    title: text("title"), // for the user's library (added)
    // Null until the Workflow's fingerprint step. UNIQUE: this is the cache.
    contentHash: text("content_hash").unique("sources_content_hash_unique"),
    status: sourceStatus("status").notNull().default("uploaded"),
    // When the fingerprint matched an existing source, the upload row points at
    // the canonical one instead of carrying a second copy of the hash (added).
    duplicateOfId: uuid("duplicate_of_id"),
    // Subject gate decision.
    gateVerdict: gateVerdict("gate_verdict"), // added: accepted/refused explicitly
    detectedNiche: text("detected_niche"),
    confidence: real("confidence"),
    reason: text("reason"),
    classifiedBy: text("classified_by"), // added: e.g. "jev" or "model"
    classificationInputs: jsonb("classification_inputs"), // added: sampled chunks + per-chunk scores (STM-22)
    error: text("error"), // added: the user-facing failure message
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.duplicateOfId],
      foreignColumns: [t.id],
      name: "sources_duplicate_of_id_fk",
    }).onDelete("set null"),
    index("sources_owner_idx").on(t.ownerId),
    check(
      "sources_confidence_range",
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
  ],
);

/**
 * Added (not on the design tab): who has uploaded each source. Needed for
 * FR-10a: questions from a private source are served only to people who
 * uploaded that same file. The fingerprint dedupes to one `sources` row, so
 * the set of uploaders has to live somewhere else. The original uploader gets
 * a row too, so the serving rule is one EXISTS check.
 */
export const sourceUploads = pgTable(
  "source_uploads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.sourceId] }),
    index("source_uploads_source_idx").on(t.sourceId),
  ],
);

export const sourceChunks = pgTable(
  "source_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    // STM-17: section headings from outermost to innermost, and the chunk's
    // [char_start, char_end) range in the normalised text.
    headingPath: text("heading_path").array().notNull().default(sql`'{}'::text[]`),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    embedding: vector("embedding"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("source_chunks_source_ordinal_unique").on(t.sourceId, t.ordinal),
    check("source_chunks_char_range", sql`${t.charStart} >= 0 and ${t.charEnd} >= ${t.charStart}`),
  ],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Restrict: a source with questions is never deleted (account deletion
    // nulls sources.owner_id instead), so private-source rules keep working.
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    // The chunk the question cites (added; `citation` carries the detail).
    chunkId: uuid("chunk_id").references(() => sourceChunks.id, { onDelete: "set null" }),
    // Stable id from a seed file so the seed script (STM-7) can upsert (added).
    externalId: text("external_id").unique(),
    origin: questionOrigin("origin").notNull(), // added
    format: questionFormat("format").notNull(),
    difficulty: questionDifficulty("difficulty").notNull(),
    topic: text("topic"), // added: results' per-topic breakdown (FR-19)
    prompt: text("prompt").notNull(), // added: common to every format
    explanation: text("explanation").notNull(), // added: every question has one (FR-17)
    payload: jsonb("payload").notNull(), // per-format shape, Zod-validated
    rubric: jsonb("rubric"), // expected points for short answers
    citation: jsonb("citation"), // heading path, char range, quote
    status: questionStatus("status").notNull().default("approved"),
    qualityScore: real("quality_score"),
    embedding: vector("embedding"), // near-dup filter (STM-19)
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("questions_has_home", sql`${t.sourceId} is not null or ${t.categoryId} is not null`),
    // Quiz assembly (STM-8): approved questions by category/difficulty/format.
    index("questions_assembly_idx")
      .on(t.categoryId, t.difficulty, t.format)
      .where(sql`${t.status} = 'approved'`),
    index("questions_source_idx").on(t.sourceId, t.difficulty),
  ],
);

// ---------------------------------------------------------------------------
// Quiz history (written once, when a quiz ends)
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The DO flush inserts with ON CONFLICT (idempotency_key) DO NOTHING, so
    // finishing twice yields exactly one row.
    idempotencyKey: text("idempotency_key").notNull().unique("sessions_idempotency_key_unique"),
    kind: sessionKind("kind").notNull(), // added: review quizzes have neither category nor source
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "restrict" }),
    mode: sessionMode("mode").notNull(),
    difficulty: questionDifficulty("difficulty"), // null for mixed (e.g. review)
    questionCount: smallint("question_count").notNull(), // added
    score: smallint("score").notNull(), // number correct
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // "Seen in the last 30 days" exclusion and the user's history list.
    index("sessions_user_finished_idx").on(t.userId, t.finishedAt),
    check("sessions_score_range", sql`${t.score} >= 0 and ${t.score} <= ${t.questionCount}`),
  ],
);

export const sessionQuestions = pgTable(
  "session_questions",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ordinal: smallint("ordinal").notNull(),
    questionId: uuid("question_id").references(() => questions.id, { onDelete: "set null" }),
    questionSnapshot: jsonb("question_snapshot").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.ordinal] }),
    index("session_questions_question_idx").on(t.questionId),
  ],
);

/**
 * One answer per session question, keyed by (session_id, ordinal) with a
 * composite FK to session_questions. The question is reached through that row
 * (and its snapshot) rather than a second, possibly inconsistent, question_id.
 */
export const answers = pgTable(
  "answers",
  {
    sessionId: uuid("session_id").notNull(),
    ordinal: smallint("ordinal").notNull(),
    rawAnswer: jsonb("raw_answer").notNull(),
    verdict: answerVerdict("verdict").notNull(),
    missedPoints: jsonb("missed_points"),
    gradedBy: gradedBy("graded_by").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.ordinal] }),
    foreignKey({
      columns: [t.sessionId, t.ordinal],
      foreignColumns: [sessionQuestions.sessionId, sessionQuestions.ordinal],
      name: "answers_session_question_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * One row per (user, question). Missing again reopens it (resolved_at null,
 * streak reset). STM-25 clears a miss after two correct answers in a row.
 */
export const misses = pgTable(
  "misses",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    missedAt: timestamp("missed_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    correctStreak: smallint("correct_streak").notNull().default(0), // added
  },
  (t) => [primaryKey({ columns: [t.userId, t.questionId] })],
);

/** Three flags from different people hide a question pending review. */
export const flags = pgTable(
  "flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    // Set null on account deletion so the evidence survives.
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // One flag per person per question; also serves "count flags on question".
    uniqueIndex("flags_question_user_unique").on(t.questionId, t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Cost control
// ---------------------------------------------------------------------------

/**
 * Added (not on the design tab): every model/classifier call with tokens and
 * cost. The design's cost-control NFR requires it, the global monthly spend
 * ceiling (STM-24) is a cross-user sum, and STM-27's cost report reads it.
 */
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    purpose: text("purpose").notNull(), // e.g. generate, classify, tag, grade, embed
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    error: text("error"), // null on success
    createdAt: createdAt(),
  },
  (t) => [
    index("model_calls_created_idx").on(t.createdAt),
    index("model_calls_source_idx").on(t.sourceId),
  ],
);

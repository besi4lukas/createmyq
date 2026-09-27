CREATE TYPE "public"."answer_verdict" AS ENUM('correct', 'partial', 'incorrect');--> statement-breakpoint
CREATE TYPE "public"."gate_verdict" AS ENUM('accepted', 'refused');--> statement-breakpoint
CREATE TYPE "public"."graded_by" AS ENUM('code', 'classifier', 'model');--> statement-breakpoint
CREATE TYPE "public"."question_difficulty" AS ENUM('beginner', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."question_format" AS ENUM('multiple_choice', 'short_answer');--> statement-breakpoint
CREATE TYPE "public"."question_origin" AS ENUM('seed', 'generated');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('approved', 'pending_review', 'retired');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('category', 'source', 'review');--> statement-breakpoint
CREATE TYPE "public"."session_mode" AS ENUM('practice', 'exam');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('pdf', 'article', 'youtube');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('uploaded', 'processing', 'ready', 'refused', 'failed', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."source_visibility" AS ENUM('private', 'group');--> statement-breakpoint
CREATE TABLE "answers" (
	"session_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"raw_answer" jsonb NOT NULL,
	"verdict" "answer_verdict" NOT NULL,
	"missed_points" jsonb,
	"graded_by" "graded_by" NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "answers_session_id_ordinal_pk" PRIMARY KEY("session_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"niche" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"user_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"email" text PRIMARY KEY NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "invites_email_lowercase" CHECK ("invites"."email" = lower("invites"."email"))
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "misses" (
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"missed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"correct_streak" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "misses_user_id_question_id_pk" PRIMARY KEY("user_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"source_id" uuid,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"category_id" uuid,
	"chunk_id" uuid,
	"external_id" text,
	"origin" "question_origin" NOT NULL,
	"format" "question_format" NOT NULL,
	"difficulty" "question_difficulty" NOT NULL,
	"topic" text,
	"prompt" text NOT NULL,
	"explanation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"rubric" jsonb,
	"citation" jsonb,
	"status" "question_status" DEFAULT 'approved' NOT NULL,
	"quality_score" real,
	"embedding" vector,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "questions_has_home" CHECK ("questions"."source_id" is not null or "questions"."category_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "session_questions" (
	"session_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"question_id" uuid,
	"question_snapshot" jsonb NOT NULL,
	CONSTRAINT "session_questions_session_id_ordinal_pk" PRIMARY KEY("session_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" "session_kind" NOT NULL,
	"category_id" uuid,
	"source_id" uuid,
	"mode" "session_mode" NOT NULL,
	"difficulty" "question_difficulty",
	"question_count" smallint NOT NULL,
	"score" smallint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "sessions_score_range" CHECK ("sessions"."score" >= 0 and "sessions"."score" <= "sessions"."question_count")
);
--> statement-breakpoint
CREATE TABLE "source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"heading_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"embedding" vector,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_chunks_char_range" CHECK ("source_chunks"."char_start" >= 0 and "source_chunks"."char_end" >= "source_chunks"."char_start")
);
--> statement-breakpoint
CREATE TABLE "source_uploads" (
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_uploads_user_id_source_id_pk" PRIMARY KEY("user_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"visibility" "source_visibility" DEFAULT 'private' NOT NULL,
	"kind" "source_kind" NOT NULL,
	"r2_key" text,
	"url" text,
	"title" text,
	"content_hash" text,
	"status" "source_status" DEFAULT 'uploaded' NOT NULL,
	"duplicate_of_id" uuid,
	"gate_verdict" "gate_verdict",
	"detected_niche" text,
	"confidence" real,
	"reason" text,
	"classified_by" text,
	"classification_inputs" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_r2_key_unique" UNIQUE("r2_key"),
	CONSTRAINT "sources_content_hash_unique" UNIQUE("content_hash"),
	CONSTRAINT "sources_confidence_range" CHECK ("sources"."confidence" is null or ("sources"."confidence" >= 0 and "sources"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_session_question_fk" FOREIGN KEY ("session_id","ordinal") REFERENCES "public"."session_questions"("session_id","ordinal") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misses" ADD CONSTRAINT "misses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "misses" ADD CONSTRAINT "misses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_chunk_id_source_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."source_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_questions" ADD CONSTRAINT "session_questions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_questions" ADD CONSTRAINT "session_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_uploads" ADD CONSTRAINT "source_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_uploads" ADD CONSTRAINT "source_uploads_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_duplicate_of_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_invites_email_fk" FOREIGN KEY ("email") REFERENCES "public"."invites"("email") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flags_question_user_unique" ON "flags" USING btree ("question_id","user_id");--> statement-breakpoint
CREATE INDEX "magic_links_email_idx" ON "magic_links" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_created_idx" ON "model_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_calls_source_idx" ON "model_calls" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "questions_assembly_idx" ON "questions" USING btree ("category_id","difficulty","format") WHERE "questions"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "questions_source_idx" ON "questions" USING btree ("source_id","difficulty");--> statement-breakpoint
CREATE INDEX "session_questions_question_idx" ON "session_questions" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "sessions_user_finished_idx" ON "sessions" USING btree ("user_id","finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_chunks_source_ordinal_unique" ON "source_chunks" USING btree ("source_id","ordinal");--> statement-breakpoint
CREATE INDEX "source_uploads_source_idx" ON "source_uploads" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "sources_owner_idx" ON "sources" USING btree ("owner_id");
-- pgvector for questions.embedding and source_chunks.embedding (near-dup filter, STM-19).
-- drizzle-kit does not create extensions, so this runs before the tables.
CREATE EXTENSION IF NOT EXISTS vector;

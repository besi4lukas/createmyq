import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Local credentials come from .env.local (written by `neon link`, gitignored).
// Variables already set in the shell win, so a one-off target works:
//   DATABASE_URL_UNPOOLED=... npm run db:migrate
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// Migrations use the direct (unpooled) connection, never Hyperdrive or the pooler.
const url = process.env.DATABASE_URL_UNPOOLED;

export default defineConfig({
  dialect: "postgresql",
  schema: "./worker/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: url ?? "" },
  strict: true,
  verbose: true,
});

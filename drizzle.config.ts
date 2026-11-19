import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  // Migrations need a direct (non-pooled) connection when the provider offers one:
  // DDL and drizzle's migration lock don't belong on a transaction-mode pooler.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});

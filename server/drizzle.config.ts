import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const migrationUrl = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;

if (!migrationUrl) {
  throw new Error("DATABASE_URL or DATABASE_URL_DIRECT is required for Drizzle");
}

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: migrationUrl,
  },
  verbose: true,
  strict: true,
});

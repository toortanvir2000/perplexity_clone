import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const sql = postgres(databaseUrl, {
  max: 1,
  ssl: "require",
});

export const db = drizzle({ client: sql });

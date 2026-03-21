import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DB_URL;

  if (!databaseUrl) {
    throw new Error(
      "DB_URL is required. Set it to a PostgreSQL connection string, for example " +
        "'postgresql://postgres:postgres@localhost:5432/letagents'."
    );
  }

  return databaseUrl;
}

export const pool = new Pool({
  connectionString: getDatabaseUrl(),
});

export const db = drizzle(pool, { schema });

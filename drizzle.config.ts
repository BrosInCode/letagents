import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/api/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DB_URL ?? "postgresql://postgres:postgres@localhost:5432/letagents",
  },
});

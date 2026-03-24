import path from "path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db, pool } from "./db/client.js";

async function main(): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  await migrate(db, { migrationsFolder });
  console.log(`Applied migrations from ${migrationsFolder}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

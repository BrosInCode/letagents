import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const API = resolve("src/api");
const CONSTRUCTOR = "src/api/db/room-rows.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * True when the source inserts into `rooms`:
 * - Drizzle: `.insert(rooms)`, `.insert(schema.rooms)`, or `.insert(alias)` for
 *   an import such as `rooms as roomTable`;
 * - SQL: `INSERT INTO rooms`, `"rooms"`, `public.rooms`, with or without a
 *   column list (not `rooms_…` tables).
 */
function insertsIntoRooms(text: string): boolean {
  const aliases = [...text.matchAll(/\brooms\s+as\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!);
  const tables = ["rooms", ...aliases].map((name) => name.replace(/\$/g, "\\$")).join("|");
  const drizzle = new RegExp(`\\.insert\\(\\s*(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?(?:${tables})\\s*\\)`);
  const sql = /INSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?rooms"?(?![\w$])/i;
  return drizzle.test(text) || sql.test(text);
}

test("the insert matcher sees every spelling and ignores other tables", () => {
  for (const text of [
    "await tx.insert(rooms).values({})",
    "await tx.insert( schema.rooms ).values({})",
    'import { rooms as roomTable } from "./schema.js";\nawait db.insert(roomTable).values({})',
    "INSERT INTO rooms (id) VALUES ($1)",
    "insert into rooms values ($1)",
    'INSERT INTO "rooms" SELECT * FROM x',
    "INSERT INTO public.rooms (id) VALUES ($1)",
    'INSERT INTO "public"."rooms" DEFAULT VALUES',
  ]) {
    assert.equal(insertsIntoRooms(text), true, text);
  }
  for (const text of [
    "INSERT INTO room_settings (room_id) VALUES ($1)",
    "INSERT INTO rooms_archive VALUES (1)",
    "await tx.insert(room_aliases).values({})",
    "await tx.insert(roomsTable2).values({})",
    "SELECT * FROM rooms",
  ]) {
    assert.equal(insertsIntoRooms(text), false, text);
  }
});

test("only db/room-rows.ts inserts into rooms, so every new room gets an origin", () => {
  const offenders = sourceFiles(API)
    .map((path) => ({ path: relative(resolve("."), path), text: readFileSync(path, "utf8") }))
    .filter(({ path, text }) => path !== CONSTRUCTOR && insertsIntoRooms(text))
    .map(({ path }) => path);
  assert.deepEqual(offenders, []);
});

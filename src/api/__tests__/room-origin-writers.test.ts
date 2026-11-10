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

test("only db/room-rows.ts inserts into rooms, so every new room gets an origin", () => {
  const offenders = sourceFiles(API)
    .map((path) => ({ path: relative(resolve("."), path), text: readFileSync(path, "utf8") }))
    .filter(({ path, text }) =>
      path !== CONSTRUCTOR && (/\.insert\(\s*rooms\s*\)/.test(text) || /INSERT\s+INTO\s+"?rooms"?\s*\(/i.test(text)))
    .map(({ path }) => path);
  assert.deepEqual(offenders, []);
});

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import test from "node:test";

const dockerfile = readFileSync("Dockerfile", "utf8");
const builderStart = dockerfile.indexOf("FROM node:22-alpine AS builder");
const migratorStart = dockerfile.indexOf("FROM node:22-alpine AS migrator");
const productionStart = dockerfile.lastIndexOf("FROM node:22-alpine");

test("every image stage receives root shared runtime modules", () => {
  assert.ok(builderStart >= 0 && migratorStart > builderStart && productionStart > migratorStart);

  const builder = dockerfile.slice(builderStart, migratorStart);
  const migrator = dockerfile.slice(migratorStart, productionStart);
  const production = dockerfile.slice(productionStart);

  assert.match(builder, /^COPY shared\/ shared\/$/m);
  assert.match(migrator, /^COPY --from=builder \/app\/shared\/ shared\/$/m);
  assert.match(production, /^COPY --from=builder \/app\/shared\/ shared\/$/m);
});

test("the web build stage receives every desktop file the shared web UI imports", () => {
  const builder = dockerfile.slice(builderStart, migratorStart);
  const copied = [...builder.matchAll(/^COPY (apps\/\S+) \1$/gm)].map(([, path]) => path);
  const imported = desktopImportsOfSharedUi();
  assert.ok(imported.length > 0, "the walk finds the shared UI's desktop imports");
  for (const path of imported) {
    assert.ok(copied.some((prefix) => path.startsWith(prefix)), `${path} is imported by shared/ui but not copied into the builder stage`);
  }
});

/** Walk shared/ui's relative imports (through desktop files too) and return the desktop files reached. */
function desktopImportsOfSharedUi() {
  const pending = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(vue|ts|mjs|js)$/.test(entry.name)) pending.push(path);
    }
  };
  visit("shared/ui");
  const seen = new Set();
  const desktop = new Set();
  const specifier = /(?:import|from)\s*(?:\(\s*)?(?:[^'";()]*?from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (!/\.(vue|ts|mjs|js)$/.test(file)) continue;
    for (const [, specifierText] of readFileSync(file, "utf8").matchAll(specifier)) {
      // Vite query suffixes (?raw, ?url, ?vue&type=...) name the same file.
      const relative = specifierText.replace(/\?.*$/, "");
      const base = normalize(join(dirname(file), relative));
      const candidates = [base, `${base}.ts`, `${base}.vue`, `${base}.js`, `${base}.mjs`, join(base, "index.ts")];
      // TypeScript ESM sources import "./x.js" for "./x.ts", and a type-only
      // import may name a module that exists only as a declaration file.
      if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".d.ts"));
      if (/\.mjs$/.test(base)) candidates.push(base.replace(/\.mjs$/, ".d.mts"));
      const target = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      // An import the walk cannot follow would hide a missing COPY, so it fails instead.
      assert.ok(target, `${file} imports "${specifierText}", which the walk cannot resolve`);
      const path = target.split(sep).join("/");
      if (path.startsWith("apps/")) desktop.add(path);
      if (path.startsWith("apps/") || path.startsWith("shared/")) pending.push(target);
    }
  }
  return [...desktop].sort();
}

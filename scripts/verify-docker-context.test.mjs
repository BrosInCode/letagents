import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

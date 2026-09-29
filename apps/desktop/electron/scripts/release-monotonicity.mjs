import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseVersion(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid desktop version ${value}.`);
  return value.split(".").map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function assertMutableReleaseMonotonicity(version, objectKeys) {
  parseVersion(version);
  const versions = objectKeys
    .map((key) => key.match(/^desktop\/v(\d+\.\d+\.\d+)\//)?.[1])
    .filter(Boolean);
  const highest = versions.sort(compareVersions).at(-1);
  if (highest && compareVersions(version, highest) < 0) {
    throw new Error(`Refusing to publish mutable channels for ${version}; immutable ${highest} artifacts already exist.`);
  }
  return highest;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [version, objectListingPath] = process.argv.slice(2);
  if (!version || !objectListingPath) {
    throw new Error("Usage: release-monotonicity.mjs <version> <R2-object-listing.json>");
  }
  const response = JSON.parse(await readFile(objectListingPath, "utf8"));
  const keys = (response.Contents ?? []).map(({ Key = "" }) => Key);
  const highest = assertMutableReleaseMonotonicity(version, keys);
  console.log(`Mutable release monotonicity verified at ${version} (highest immutable: ${highest ?? "none"}).`);
}

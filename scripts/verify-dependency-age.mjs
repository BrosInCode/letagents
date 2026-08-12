import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCKFILES = [
  "package-lock.json",
  "apps/desktop/package-lock.json",
  "src/web/package-lock.json",
];
const DEFAULT_POLICY = ".github/dependency-age-policy.json";
const NPM_REGISTRY = "https://registry.npmjs.org/";

function packageNameFromLockPath(packagePath) {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return index === -1 ? null : packagePath.slice(index + marker.length) || null;
}

export function collectLockedPackages(lockfiles) {
  const packages = new Map();
  const violations = [];

  for (const { file, lock } of lockfiles) {
    for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
      if (!packagePath || entry.link || !entry.version) continue;

      const name = packageNameFromLockPath(packagePath);
      if (!name) continue;

      if (!entry.resolved) {
        violations.push(`${file}: ${name}@${entry.version} is missing a locked registry tarball URL.`);
        continue;
      }

      if (!entry.resolved.startsWith(NPM_REGISTRY)) {
        violations.push(
          `${file}: ${name}@${entry.version} resolves outside the public npm registry: ${entry.resolved}`,
        );
        continue;
      }

      if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
        violations.push(`${file}: ${name}@${entry.version} is missing SHA-512 lockfile integrity.`);
        continue;
      }

      const key = `${name}@${entry.version}`;
      const existing = packages.get(key) ?? { name, version: entry.version, lockfiles: [] };
      existing.lockfiles.push(file);
      packages.set(key, existing);
    }
  }

  return { packages: [...packages.values()], violations };
}

export function evaluateReleaseAges({ packages, metadataByName, policy, now = Date.now() }) {
  const minimumAgeMs = policy.minimumAgeDays * DAY_MS;
  const exceptions = new Map(
    policy.exceptions.map((exception) => [`${exception.name}@${exception.version}`, exception]),
  );
  const violations = [];
  const acceptedExceptions = [];

  for (const dependency of packages) {
    const key = `${dependency.name}@${dependency.version}`;
    const publishedAt = metadataByName.get(dependency.name)?.time?.[dependency.version];
    const publishedTime = Date.parse(publishedAt ?? "");

    if (!Number.isFinite(publishedTime)) {
      violations.push(`${key}: npm registry metadata has no valid publication time.`);
      continue;
    }

    const ageMs = now - publishedTime;
    if (ageMs < 0) {
      violations.push(`${key}: publication time ${publishedAt} is in the future.`);
      continue;
    }

    if (ageMs >= minimumAgeMs) continue;

    const exception = exceptions.get(key);
    if (exception) {
      acceptedExceptions.push({
        key,
        ageDays: ageMs / DAY_MS,
        reason: exception.reason,
      });
      continue;
    }

    violations.push(
      `${key}: published ${(ageMs / DAY_MS).toFixed(2)} days ago; policy requires ${policy.minimumAgeDays} days.`,
    );
  }

  return { violations, acceptedExceptions };
}

function validatePolicy(policy) {
  if (!Number.isInteger(policy.minimumAgeDays) || policy.minimumAgeDays < 1) {
    throw new Error("minimumAgeDays must be a positive integer.");
  }
  if (!Array.isArray(policy.exceptions)) {
    throw new Error("exceptions must be an array.");
  }

  const seen = new Set();
  for (const exception of policy.exceptions) {
    if (!exception.name || !exception.version || !exception.reason?.trim()) {
      throw new Error("Every exception requires an exact name, version, and non-empty reason.");
    }
    const key = `${exception.name}@${exception.version}`;
    if (seen.has(key)) throw new Error(`Duplicate dependency-age exception: ${key}`);
    seen.add(key);
  }
}

async function fetchRegistryMetadata(name, attempts = 3) {
  const url = `${NPM_REGISTRY}${encodeURIComponent(name)}`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }

  throw new Error(`Could not read npm publication metadata for ${name}: ${lastError?.message}`);
}

async function fetchAllMetadata(packages, concurrency = 20) {
  const names = [...new Set(packages.map((dependency) => dependency.name))];
  const metadataByName = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < names.length) {
      const name = names[cursor];
      cursor += 1;
      metadataByName.set(name, await fetchRegistryMetadata(name));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return metadataByName;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const root = process.cwd();
  const policy = await readJson(path.join(root, DEFAULT_POLICY));
  validatePolicy(policy);

  const lockfiles = await Promise.all(
    DEFAULT_LOCKFILES.map(async (file) => ({ file, lock: await readJson(path.join(root, file)) })),
  );
  const collected = collectLockedPackages(lockfiles);
  if (collected.violations.length > 0) {
    throw new Error(`Lockfile policy failed:\n- ${collected.violations.join("\n- ")}`);
  }

  const metadataByName = await fetchAllMetadata(collected.packages);
  const result = evaluateReleaseAges({ packages: collected.packages, metadataByName, policy });

  for (const exception of result.acceptedExceptions) {
    console.log(
      `Cooldown exception: ${exception.key} (${exception.ageDays.toFixed(2)} days old) — ${exception.reason}`,
    );
  }

  if (result.violations.length > 0) {
    throw new Error(`Dependency cooldown failed:\n- ${result.violations.join("\n- ")}`);
  }

  console.log(
    `Verified ${collected.packages.length} locked package versions against a ${policy.minimumAgeDays}-day release cooldown.`,
  );
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

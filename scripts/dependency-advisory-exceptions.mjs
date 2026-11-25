/**
 * Narrow, dated exceptions to the dependency advisory audit
 * (scripts/verify-dependency-advisories.mjs).
 *
 * An exception names one advisory and one package. It holds only while every
 * copy of that package in the audited lockfile is a dev dependency (the
 * lockfile's flags here, and npm's own view in the runner), and only until
 * its end date; after that date the audit fails again. A dev dependency that
 * ships in a bundle (BUNDLED_DEV_PACKAGES below) counts as not dev. Any advisory without
 * an exception still fails the audit. Add one only with the repository
 * owner's yes, and remove it once a fixed version ships.
 */

import { readFileSync } from "node:fs";

export const ADVISORY_EXCEPTIONS = Object.freeze([
  Object.freeze({
    advisory: "GHSA-fc5q-39xc-vjpf",
    packageName: "picomatch",
    // The exception ends at 00:00 UTC on this day.
    endsOn: "2026-12-18",
    reason:
      "picomatch ReDoS through single-branch repeated extglobs. No fixed version is on npm yet " +
      "(the newest, 4.0.7, is affected). Only vite's build tooling (fdir, tinyglobby) installs it, " +
      "as a dev dependency of src/web and apps/desktop; LetAgents code never imports it.",
  }),
]);

const ADVISORY_ID = /\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})\/?$/i;

/** The GHSA id an `npm audit` advisory entry links to, or null. */
export function advisoryIdOf(advisory) {
  const url = typeof advisory?.url === "string" ? advisory.url : "";
  const match = ADVISORY_ID.exec(url);
  return match ? match[1] : null;
}

/** Every lockfile path that installs `packageName`, at any depth. */
export function lockfilePackagePaths(lockfile, packageName) {
  const packages = lockfile && typeof lockfile === "object" ? lockfile.packages : null;
  if (!packages || typeof packages !== "object") return [];
  const suffix = `node_modules/${packageName}`;
  return Object.keys(packages).filter((key) => key === suffix || key.endsWith(`/${suffix}`));
}

const desktopBundled = JSON.parse(readFileSync(new URL("../apps/desktop/renderer-bundled-packages.json", import.meta.url), "utf8"));

/**
 * Dev dependencies whose code ships all the same, by the name of the lockfile
 * that installs them: Vite bundles the desktop renderer's packages into the
 * app (apps/desktop/renderer-bundled-packages.json, the list that packaging
 * uses too). Their own dependencies ship with them.
 */
export const BUNDLED_DEV_PACKAGES = Object.freeze({
  "letagents-desktop": Object.freeze([
    ...Object.keys(desktopBundled.packages),
    ...Object.keys(desktopBundled.bundledDependencies ?? {}),
  ]),
});

/** The lockfile entry that `name` resolves to from the package at `from`, as Node finds it. */
function resolveLockfileDependency(packages, from, name) {
  for (let base = from; ;) {
    const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!base) return null;
    const parent = base.lastIndexOf("/node_modules/");
    base = parent < 0 ? "" : base.slice(0, parent);
  }
}

/**
 * The lockfile paths of the bundled packages and of everything they depend
 * on (also optional dependencies, not peers). These ship in the app even
 * when the lockfile marks them dev.
 */
export function bundledPackagePaths(lockfile, roots = BUNDLED_DEV_PACKAGES[lockfile?.name] ?? []) {
  const packages = lockfile && typeof lockfile === "object" && lockfile.packages && typeof lockfile.packages === "object"
    ? lockfile.packages
    : {};
  const found = new Set();
  const queue = roots.map((name) => resolveLockfileDependency(packages, "", name)).filter(Boolean);
  while (queue.length > 0) {
    const path = queue.pop();
    if (found.has(path)) continue;
    found.add(path);
    const entry = packages[path] ?? {};
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const target = resolveLockfileDependency(packages, path, name);
      if (target) queue.push(target);
    }
  }
  return found;
}

function endOf(exception) {
  return Date.parse(`${exception.endsOn}T00:00:00Z`);
}

/** Whether a listed package reaches an advisory through its `via` chain. */
function reachesAdvisory(vulnerabilities, name, seen = new Set()) {
  if (seen.has(name)) return false;
  seen.add(name);
  const via = Array.isArray(vulnerabilities[name]?.via) ? vulnerabilities[name].via : [];
  return via.some((item) => (typeof item === "string"
    ? Object.hasOwn(vulnerabilities, item) && reachesAdvisory(vulnerabilities, item, seen)
    : item !== null && typeof item === "object"));
}

/**
 * Decides whether an `npm audit --json` report that found advisories may
 * pass. It passes only when every advisory in it has an exception that still
 * applies; anything it cannot read fails closed. The runner then also asks
 * npm whether it installs the package in production (see `used`).
 *
 * Returns `{ allowed, notes, blocking, used }`: `notes` say which exceptions
 * were used and when they end, `blocking` says why the audit must fail, and
 * `used` lists the exceptions the report needed.
 */
export function evaluateAdvisoryExceptions(auditJson, lockfile, { now, exceptions = ADVISORY_EXCEPTIONS }) {
  const blocking = [];
  const bundled = bundledPackagePaths(lockfile);
  const used = new Map();
  const vulnerabilities = auditJson && typeof auditJson === "object" ? auditJson.vulnerabilities : null;
  if (!vulnerabilities || typeof vulnerabilities !== "object" || Object.keys(vulnerabilities).length === 0) {
    return { allowed: false, notes: [], blocking: ["The audit report lists no vulnerabilities to check, so it fails closed."], used: [] };
  }
  const total = auditJson?.metadata?.vulnerabilities?.total;
  if (total !== Object.keys(vulnerabilities).length) {
    blocking.push(`The report counts ${total} vulnerabilities but lists ${Object.keys(vulnerabilities).length}, so it fails closed.`);
  }

  const advisories = [];
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const via = Array.isArray(entry?.via) ? entry.via : [];
    if (via.length === 0) blocking.push(`${name}: the report gives no advisory for it.`);
    for (const item of via) {
      if (typeof item === "string") {
        // A package that is only vulnerable through another listed package.
        if (!Object.hasOwn(vulnerabilities, item)) blocking.push(`${name}: it depends on ${item}, which the report does not list.`);
        continue;
      }
      if (item === null || typeof item !== "object") {
        blocking.push(`${name}: the report gives an advisory it cannot read.`);
        continue;
      }
      advisories.push({ id: advisoryIdOf(item), packageName: item?.name ?? null, entryName: name, nodes: entry?.nodes });
    }
  }
  if (advisories.length === 0) blocking.push("The report names no advisory, so it fails closed.");
  for (const name of Object.keys(vulnerabilities)) {
    if (!reachesAdvisory(vulnerabilities, name)) blocking.push(`${name}: no advisory explains it, so it fails closed.`);
  }

  for (const advisory of advisories) {
    const exception = advisory.id
      ? exceptions.find((candidate) => candidate.advisory.toLowerCase() === advisory.id.toLowerCase())
      : null;
    if (!exception) {
      blocking.push(`${advisory.packageName ?? advisory.entryName}: ${advisory.id ?? "an advisory without a GHSA id"} has no exception.`);
      continue;
    }
    if (advisory.packageName !== exception.packageName) {
      blocking.push(`${exception.advisory} is excepted only for ${exception.packageName}, not for ${advisory.packageName ?? advisory.entryName}.`);
      continue;
    }
    if (advisory.entryName !== exception.packageName) {
      blocking.push(`${exception.advisory} is excepted only on ${exception.packageName}'s own entry, not on ${advisory.entryName}'s.`);
      continue;
    }
    const paths = lockfilePackagePaths(lockfile, exception.packageName);
    const notDev = paths.filter((key) => lockfile.packages[key]?.dev !== true);
    const reported = Array.isArray(advisory.nodes) ? advisory.nodes : [];
    const unknown = reported.filter((node) => !paths.includes(node));
    if (paths.length === 0 || unknown.length > 0) {
      blocking.push(`${exception.advisory}: the lockfile does not show where ${exception.packageName} is installed, so it fails closed.`);
      continue;
    }
    if (notDev.length > 0) {
      blocking.push(
        `${exception.advisory} is excepted only while every ${exception.packageName} in the lockfile is a dev dependency. ` +
          `Not dev: ${notDev.join(", ")}.`,
      );
      continue;
    }
    const bundledPaths = paths.filter((key) => bundled.has(key));
    if (bundledPaths.length > 0) {
      blocking.push(
        `${exception.advisory} is excepted only for packages that are not shipped. ${exception.packageName} is a dev dependency, ` +
          `but its code ships in a bundle: ${bundledPaths.join(", ")}.`,
      );
      continue;
    }
    if (!(now.getTime() < endOf(exception))) {
      blocking.push(
        `The exception for ${exception.advisory} in ${exception.packageName} ended on ${exception.endsOn}. ` +
          `Upgrade ${exception.packageName}, or ask the repository owner to decide again.`,
      );
      continue;
    }
    used.set(exception.advisory, { exception, paths });
  }

  const notes = [...used.values()].map(({ exception, paths }) =>
    `Allowing ${exception.advisory} in ${exception.packageName} (dev only: ${paths.join(", ")}) until ${exception.endsOn} 00:00 UTC. ` +
      `This exception ends on that date; remove it once a fixed ${exception.packageName} ships.`);
  return {
    allowed: blocking.length === 0 && used.size > 0,
    notes,
    blocking,
    used: [...used.values()].map(({ exception, paths }) => ({ advisory: exception.advisory, packageName: exception.packageName, paths })),
  };
}

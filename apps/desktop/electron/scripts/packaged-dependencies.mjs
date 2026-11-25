// Which packages the packaged app installs into its node_modules.
//
// package-artifact.mjs runs `npm ci --omit=dev` in the app folder, so every
// entry of "dependencies" is installed with all its own dependencies. The
// renderer does not need them: Vite bundles its packages into dist-renderer.
// Only code that Node or Electron loads from the build output (main, preload,
// daemon, provider runtime, daemon contract and the shared files they import)
// needs an installed package. So a package that only the renderer imports is
// a dev dependency, as highlight.js and monaco-editor already were. The list
// of these packages is renderer-bundled-packages.json.

import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundled = JSON.parse(readFileSync(join(DESKTOP_ROOT, "renderer-bundled-packages.json"), "utf8"));

/** Packages that Vite bundles into dist-renderer and the app does not install. */
export const RENDERER_BUNDLED_PACKAGES = Object.freeze(Object.keys(bundled.packages));

/** `<package>/<file>` of every licence file that the renderer notices must hold. */
export const RENDERER_NOTICE_FILES = Object.freeze(
  Object.entries({ ...bundled.packages, ...bundled.bundledDependencies })
    .flatMap(([name, { notices }]) => notices.map((file) => `${name}/${file}`)),
);

/** The source folders that compile to the build output the app runs, and what each leaves out. */
const RUNTIME_SOURCE_FOLDERS = Object.freeze([
  // electron/scripts holds packaging, smoke and spike scripts; the app does not run them.
  { folder: "electron", skip: ["electron/scripts"] },
  { folder: "daemon", skip: [] },
  { folder: "provider-runtime", skip: [] },
  { folder: "daemon-contract", skip: ["daemon-contract/generate-schema.ts"] },
]);
/** Script files that a preview build copies into the app folder as they are. */
const RUNTIME_SCRIPT_FILES = Object.freeze(["electron/scripts/preview-bootstrap.mjs", "electron/scripts/preview-isolation.cjs"]);

const TEST_FOLDER_NAMES = new Set(["__tests__", "__fixtures__", "__mocks__"]);
const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js|vue)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const TYPE_ONLY = /^\s*(?:import|export)\s+type\b[^;]*?from\s*["'][^"']+["']/gm;
// import/export ... from "x", import("x"), import "x", require("x"),
// require.resolve("x") and createRequire(import.meta.url)("x"). In a call, a
// template literal without a ${} part is a plain string too.
const CALL = String.raw`\bimport\s*\(\s*|\brequire(?:\.resolve)?\s*\(\s*|\bcreateRequire\s*\([^()]*\)\s*\(\s*`;
const SPECIFIER = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s+|${CALL})(["'])([^"']+)\1|(?:${CALL})(\x60)([^\x60$]+)\x60`, "g");
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const BUILTIN = new Set(builtinModules);

function isTestPath(path) {
  const parts = path.split(/[\\/]/);
  return parts.some((part) => TEST_FOLDER_NAMES.has(part)) || /\.(?:test|spec)\.[cm]?[jt]s$/.test(parts.at(-1) ?? "");
}

function sourceFiles(folder, desktopRoot, skip, found = []) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    const inDesktop = relative(desktopRoot, path).split(sep).join("/");
    if (skip.includes(inDesktop) || entry.name === "node_modules" || isTestPath(inDesktop)) continue;
    if (entry.isDirectory()) sourceFiles(path, desktopRoot, skip, found);
    else if (SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

/** Every import, require and createRequire specifier in a source text, without type-only imports. */
export function importSpecifiers(source) {
  return [...source.replace(TYPE_ONLY, "").matchAll(SPECIFIER)].map((match) => match[2] ?? match[4]);
}

/** The package name of a bare import, or null for a relative path, an import name or a Node module. */
export function importedPackageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || specifier.startsWith("@/")) return null;
  if (specifier.startsWith("node:") || BUILTIN.has(specifier.split("/")[0])) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  // Text that only looks like an import, such as a quote in a comment.
  return PACKAGE_NAME.test(name) ? name : null;
}

function resolveSource(desktopRoot, packageImports, from, specifier) {
  let base;
  if (specifier.startsWith("#")) {
    for (const [pattern, target] of Object.entries(packageImports)) {
      const source = typeof target === "string" ? target : target?.["letagents-source"];
      const [prefix, suffix] = pattern.split("*");
      if (typeof source === "string" && specifier.startsWith(prefix) && specifier.endsWith(suffix ?? "")) {
        const middle = specifier.slice(prefix.length, specifier.length - (suffix ?? "").length);
        base = resolve(desktopRoot, source.replace("*", middle));
        break;
      }
    }
    if (!base) return null;
  } else if (specifier.startsWith("@/")) {
    // The renderer's Vite alias.
    base = join(desktopRoot, "renderer", "src", specifier.slice(2));
  } else {
    base = resolve(dirname(from), specifier.split("?")[0]);
  }
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), base.replace(/\.cjs$/, ".cts"), `${base}.ts`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function scanImports(desktopRoot, queue) {
  const packageImports = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).imports ?? {};
  const repositoryRoot = resolve(desktopRoot, "../..");
  const seen = new Set();
  const packages = new Map();
  const testImports = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const from = relative(repositoryRoot, file).split(sep).join("/");
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".") || specifier.startsWith("#") || specifier.startsWith("@/")) {
        const target = resolveSource(desktopRoot, packageImports, file, specifier);
        // Only code imports code: a required package.json or JSON file is data.
        if (!target || !SOURCE_FILE.test(target)) continue;
        if (isTestPath(relative(repositoryRoot, target))) testImports.push(`${from} imports ${specifier}`);
        else queue.push(target);
        continue;
      }
      const name = importedPackageName(specifier);
      if (!name) continue;
      if (!packages.has(name)) packages.set(name, new Set());
      packages.get(name).add(from);
    }
  }
  return { files: seen.size, packages, testImports };
}

/**
 * The packages that the app's own code imports at run time, from the source
 * folders of the build output and every repository file they import (such as
 * the shared folder). Type-only imports are left out: the compiler removes
 * them. Also gives the test files that any of this code imports.
 */
export function runtimeImports(desktopRoot = DESKTOP_ROOT) {
  return scanImports(desktopRoot, [
    ...RUNTIME_SOURCE_FOLDERS.flatMap(({ folder, skip }) => sourceFiles(join(desktopRoot, folder), desktopRoot, skip)),
    ...RUNTIME_SCRIPT_FILES.map((file) => join(desktopRoot, file)),
  ]);
}

/** The packages that the renderer's source (and the shared files it imports) imports: what Vite bundles. */
export function rendererImports(desktopRoot = DESKTOP_ROOT) {
  return scanImports(desktopRoot, sourceFiles(join(desktopRoot, "renderer", "src"), desktopRoot, []));
}

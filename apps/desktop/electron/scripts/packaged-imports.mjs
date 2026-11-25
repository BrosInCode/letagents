// The "imports" field of the desktop package.json, as the packaged app gets it.
//
// In the repository an entry such as "#provider-runtime/*.js" has three
// targets: a source condition for tests, the type declarations, and the build
// output. A shipped app has only the build output. With the other targets
// left in, a `--conditions` flag or a NODE_OPTIONS variable could point the
// name at a source folder that the app does not contain, and the daemon,
// which runs the packaged program in Node mode, would fail to load its code.

import { existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Keep only the `default` target of each conditional entry. */
export function packagedImports(imports) {
  if (imports === undefined) return undefined;
  if (imports === null || typeof imports !== "object" || Array.isArray(imports)) {
    throw new Error("package.json imports must be an object.");
  }
  const packaged = {};
  for (const [name, target] of Object.entries(imports)) {
    if (typeof target === "string") {
      packaged[name] = target;
      continue;
    }
    if (target === null || typeof target !== "object" || Array.isArray(target) || typeof target.default !== "string") {
      throw new Error(`package.json imports entry ${name} must be a path or have a default path.`);
    }
    packaged[name] = target.default;
  }
  return packaged;
}

/** The package.json object to write into the packaged app. */
export function packagedPackageJson(packageJson) {
  if (packageJson.imports === undefined) return packageJson;
  return { ...packageJson, imports: packagedImports(packageJson.imports) };
}

/** Folder names of tests and their fixtures in the build output. */
const TEST_FOLDER_NAMES = new Set(["__tests__", "__fixtures__", "__mocks__"]);

/**
 * Whether a path in the build output, relative to its build folder, is a
 * compiled test, a test fixture or the source map of one. The compilers
 * build the tests too (the electron build type-checks them), but the
 * packaged app never runs them.
 */
export function isTestBuildPath(path) {
  const parts = path.split(/[\\/]/);
  return parts.some((part) => TEST_FOLDER_NAMES.has(part))
    || /\.(test|spec)\.[cm]?js(\.map)?$/.test(parts.at(-1) ?? "");
}

/** Build output files that the packaged app runs: no declarations, build state or tests. */
export function isPackagedBuildFile(path) {
  return !/\.d\.[cm]?ts(\.map)?$/.test(path) && !path.endsWith(".tsbuildinfo") && !isTestBuildPath(path);
}

/**
 * A `cp` filter for one build folder. It skips test folders as a whole, and
 * reads each path relative to the build folder, so a folder name above it
 * does not count.
 */
export function packagedBuildFilter(buildFolder) {
  return async (source) => {
    const path = relative(buildFolder, source);
    if (path === "") return true;
    return (await stat(source)).isDirectory() ? !isTestBuildPath(path) : isPackagedBuildFile(path);
  };
}

/** The test files and folders in the build folders of an app folder. */
export function packagedTestPaths(app, buildFolders) {
  const found = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const inApp = relative(app, path).split(sep).join("/");
      const inBuild = inApp.split("/").slice(1).join("/");
      if (isTestBuildPath(inBuild)) found.push(inApp);
      else if (entry.isDirectory()) visit(path);
    }
  };
  for (const buildFolder of buildFolders) {
    if (existsSync(join(app, buildFolder))) visit(join(app, buildFolder));
  }
  return found;
}

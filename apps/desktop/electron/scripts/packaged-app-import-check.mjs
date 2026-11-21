// Run by the packaged program in Node mode, with the packaged app folder as
// the argument:
//
//   ELECTRON_RUN_AS_NODE=1 <packaged program> packaged-app-import-check.mjs <app folder>
//
// It proves that the shipped app can load the code that the daemon loads
// only when an agent starts, which a start of the app alone does not load:
//
//   1. the app's package.json has no conditional import target, and no other
//      package.json in the shipped build output declares import names. Then
//      a name has one target for every file and for both kinds of module
//      loading (import and require);
//   2. every "#..." import name in the shipped build output resolves to an
//      existing file inside that build output, from the place that uses it,
//      and to the same file as from the app's own package.json. Node keeps
//      one module for one file, so two users of one name that resolve to
//      two files would each get their own copy of its state;
//   3. every file that the build output names by a path from its own place,
//      `new URL("<relative path>", import.meta.url)`, exists. A moved file
//      changes its depth in the build output, and the compiler does not see
//      a path that breaks that way;
//   4. each provider adapter entry file loads.
//
// This file imports nothing outside Node, because it runs inside the app.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PROVIDER_ADAPTER_ENTRIES = [
  "codex-provider-adapter.js",
  "claude-code-provider-adapter.js",
  "cursor-provider-adapter.js",
  "open-model-provider-adapter.js",
];
/** Where an adapter entry file can be: the shared package, or the Electron build before the adapters move. */
const ADAPTER_FOLDERS = ["dist-provider-runtime", join("dist-electron", "main", "agents")];
const BUILD_FOLDERS = ["dist-electron", "dist-daemon", "dist-provider-runtime"];

function buildFiles(directory, found = [], pattern = /\.(js|mjs|cjs)$/) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) buildFiles(path, found, pattern);
    else if (pattern.test(entry.name)) found.push(path);
  }
  return found;
}

function inside(folder, path) {
  const rest = relative(folder, path);
  return rest !== "" && !rest.startsWith("..") && !rest.startsWith(sep) && !/^[A-Za-z]:/.test(rest);
}

export async function checkPackagedAppImports(appRoot, { log = console.log } = {}) {
  const app = realpathSync(appRoot);
  const packageJson = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  const names = Object.keys(packageJson.imports ?? {});
  for (const name of names) {
    if (typeof packageJson.imports[name] !== "string") {
      throw new Error(`package.json imports entry ${name} has conditional targets; a packaged app must have the build output only.`);
    }
  }

  // Node takes the meaning of a "#" name from the nearest package.json above
  // the file that uses it. A second map below the build output could give
  // some files another target, and could give `import` and `require` two
  // different ones, which a check by one kind of resolution does not see.
  for (const folder of BUILD_FOLDERS) {
    const root = join(app, folder);
    if (!existsSync(root)) continue;
    for (const file of buildFiles(root, [], /^package\.json$/)) {
      let nested;
      try { nested = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
        throw new Error(`${relative(app, file)} is not readable JSON: ${error.message}`);
      }
      if (nested !== null && typeof nested === "object" && nested.imports !== undefined) {
        throw new Error(`${relative(app, file)} declares import names; only the package.json of the packaged app may, or two files could load two copies of one module`);
      }
    }
  }

  const importName = /(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)["'](#[^"']+)["']/g;
  // What a name means in this app: its target from the app's package.json.
  const resolveFromApp = createRequire(join(app, "package.json"));
  const canonical = new Map();
  let resolved = 0;
  for (const folder of BUILD_FOLDERS) {
    const root = join(app, folder);
    if (!existsSync(root)) continue;
    for (const file of buildFiles(root)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("#")) continue;
      const resolveFrom = createRequire(file);
      for (const match of source.matchAll(importName)) {
        let target;
        try {
          target = realpathSync(resolveFrom.resolve(match[1]));
        } catch (error) {
          throw new Error(`${relative(app, file)} imports ${match[1]}, which does not resolve in the packaged app: ${error.message}`);
        }
        if (!BUILD_FOLDERS.some((buildFolder) => inside(join(app, buildFolder), target))) {
          throw new Error(`${relative(app, file)} imports ${match[1]}, which resolves outside the packaged build output: ${target}`);
        }
        if (!canonical.has(match[1])) {
          try {
            canonical.set(match[1], realpathSync(resolveFromApp.resolve(match[1])));
          } catch (error) {
            throw new Error(`${match[1]} does not resolve from the package.json of the packaged app: ${error.message}`);
          }
        }
        if (target !== canonical.get(match[1])) {
          throw new Error(`${relative(app, file)} imports ${match[1]} and gets ${relative(app, target)}, but the app's package.json gives ${relative(app, canonical.get(match[1]))}; the two would be two copies of one module`);
        }
        resolved += 1;
      }
    }
  }
  log(`packaged-imports: ${resolved} use(s) of ${canonical.size} import name(s) resolve inside the app, each name to one file`);

  // Compiled tests are in the build output too; their paths point at fixtures
  // of the repository, which a packaged app does not have.
  const ownPlacePath = /new URL\(\s*(["'])(\.\.?\/[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;
  let paths = 0;
  for (const folder of BUILD_FOLDERS) {
    const root = join(app, folder);
    if (!existsSync(root)) continue;
    for (const file of buildFiles(root)) {
      if (relative(root, file).split(sep).includes("__tests__")) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("import.meta.url")) continue;
      for (const match of source.matchAll(ownPlacePath)) {
        const target = resolve(dirname(file), match[2]);
        if (!existsSync(target)) {
          throw new Error(`${relative(app, file)} names ${match[2]} from its own place, and the packaged app has no file there: ${target}`);
        }
        paths += 1;
      }
    }
  }
  log(`packaged-imports: ${paths} path(s) from a file's own place exist`);

  for (const entry of PROVIDER_ADAPTER_ENTRIES) {
    const path = ADAPTER_FOLDERS.map((folder) => join(app, folder, entry)).find((candidate) => existsSync(candidate));
    if (!path) throw new Error(`the packaged app has no provider adapter entry file ${entry}`);
    try {
      await import(pathToFileURL(path).href);
    } catch (error) {
      throw new Error(`${relative(app, path)} does not load in the packaged app: ${error?.stack ?? error}`);
    }
    log(`packaged-imports: loaded ${relative(app, path)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const appRoot = process.argv[2];
  if (!appRoot) {
    console.error("usage: packaged-app-import-check.mjs <packaged app folder>");
    process.exit(2);
  }
  try {
    await checkPackagedAppImports(appRoot);
    // An adapter module can leave a timer or a handle open; the check is done.
    process.exit(0);
  } catch (error) {
    console.error(`packaged-imports: FAILED: ${error.message}`);
    process.exit(1);
  }
}

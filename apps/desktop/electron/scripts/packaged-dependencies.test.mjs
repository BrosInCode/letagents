import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  importedPackageName,
  importSpecifiers,
  RENDERER_BUNDLED_PACKAGES,
  RENDERER_NOTICE_FILES,
  rendererImports,
  runtimeImports,
} from "./packaged-dependencies.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const lockfile = JSON.parse(readFileSync(join(desktopRoot, "package-lock.json"), "utf8"));
const dependencies = desktopPackage.dependencies ?? {};
const devDependencies = desktopPackage.devDependencies ?? {};
// Electron gives its own module to the code it runs; the app does not install it.
const PROVIDED_BY_ELECTRON = new Set(["electron"]);
const imports = runtimeImports(desktopRoot);

function packagesOf(names) {
  return [...names].sort().map((name) => `${name} (${[...imports.packages.get(name) ?? []].slice(0, 2).join(", ")})`);
}

test("the import scan reads the app's own code and its shared files", () => {
  assert.ok(imports.files > 300, `only ${imports.files} files were read`);
  for (const name of ["zod", "ws", "electron-updater"]) assert.ok(imports.packages.has(name), `${name} is not found`);
  assert.equal(importedPackageName("@lucide/vue/icons"), "@lucide/vue");
  assert.equal(importedPackageName("three/examples/jsm/loaders/GLTFLoader.js"), "three");
  assert.equal(importedPackageName("node:fs"), null);
  assert.equal(importedPackageName("fs/promises"), null);
  assert.equal(importedPackageName("#provider-runtime/x.js"), null);
  assert.equal(importedPackageName("not browser"), null);
});

test("every package that the app's own code imports is a dependency", () => {
  const missing = [...imports.packages.keys()].filter((name) => !PROVIDED_BY_ELECTRON.has(name) && !Object.hasOwn(dependencies, name));
  assert.deepEqual(packagesOf(missing), [], "npm ci --omit=dev in the app folder installs only dependencies");
});

test("every dependency is imported by the app's own code, or is a peer of a dependency that is", () => {
  // `ai` is a peer dependency of @openai/agents-extensions and @openrouter/ai-sdk-provider.
  const needed = new Set([...imports.packages.keys()].filter((name) => Object.hasOwn(dependencies, name)));
  for (let grown = true; grown;) {
    grown = false;
    for (const name of [...needed]) {
      for (const peer of Object.keys(lockfile.packages[`node_modules/${name}`]?.peerDependencies ?? {})) {
        if (Object.hasOwn(dependencies, peer) && !needed.has(peer)) {
          needed.add(peer);
          grown = true;
        }
      }
    }
  }
  const unneeded = Object.keys(dependencies).filter((name) => !needed.has(name));
  assert.deepEqual(unneeded, [], "a package that only the renderer imports is a dev dependency: Vite bundles it into dist-renderer");
});

test("the renderer's bundled packages are dev dependencies that the app does not install", () => {
  for (const name of RENDERER_BUNDLED_PACKAGES) {
    assert.ok(Object.hasOwn(devDependencies, name), `${name} must be a dev dependency`);
    assert.equal(Object.hasOwn(dependencies, name), false, `${name} must not be a dependency`);
    assert.equal(imports.packages.has(name), false, `${name} is imported by ${packagesOf([name])}`);
    assert.equal(lockfile.packages[`node_modules/${name}`]?.dev, true, `the lockfile must mark ${name} as dev`);
  }
});

test("no code that the app runs imports a test file", () => {
  assert.deepEqual(imports.testImports, []);
});

test("the import scan reads the require forms that the app's code uses", () => {
  const source = [
    'import { a } from "pkg-a";',
    'export * from "pkg-b/sub";',
    'import "pkg-c";',
    'const d = await import("pkg-d");',
    'const e = createRequire(import.meta.url)("pkg-e");',
    'const f = createRequire(import.meta.url)(\n  "pkg-f",\n);',
    "const require = createRequire(import.meta.url);",
    'const g = require("pkg-g");',
    'const h = require.resolve("pkg-h");',
    "const i = await import(`pkg-i/x.js`);",
    "const j = require(`pkg-j`);",
    "const k = await import(`${dynamic}/k.js`);",
    'import type { L } from "pkg-l";',
    "// A comment that reads from `cwd` is not an import.",
  ].join("\n");
  assert.deepEqual(importSpecifiers(source), ["pkg-a", "pkg-b/sub", "pkg-c", "pkg-d", "pkg-e", "pkg-f", "pkg-g", "pkg-h", "pkg-i/x.js", "pkg-j"]);
});

test("every package that the renderer imports is a dependency of the app's own code or is in the bundled list", () => {
  const renderer = rendererImports(desktopRoot);
  assert.ok(renderer.files > 300, `only ${renderer.files} renderer files were read`);
  const unlisted = [...renderer.packages.keys()].filter((name) => !Object.hasOwn(dependencies, name) && !RENDERER_BUNDLED_PACKAGES.includes(name));
  assert.deepEqual(unlisted, [], "add the package to renderer-bundled-packages.json, with its licence files");
  const unused = RENDERER_BUNDLED_PACKAGES.filter((name) => !renderer.packages.has(name));
  assert.deepEqual(unused, [], "the renderer no longer imports these bundled packages");
});

test("the renderer notices hold the licence of every bundled package", () => {
  const viteConfig = readFileSync(join(desktopRoot, "vite.config.ts"), "utf8");
  assert.match(viteConfig, /import rendererBundledPackages from "\.\/renderer-bundled-packages\.json"/);
  assert.match(viteConfig, /const files = rendererNoticeFiles\(\);/);
  for (const name of RENDERER_BUNDLED_PACKAGES) {
    const licences = RENDERER_NOTICE_FILES.filter((file) => file.startsWith(`${name}/`));
    assert.ok(licences.length > 0, `${name} has no licence file in the notices`);
    // Every licence file the package has, by its real name.
    const own = readdirSync(join(desktopRoot, "node_modules", name)).filter((file) => /^(licen[cs]e|copying|notice)/i.test(file));
    for (const file of own) assert.ok(licences.includes(`${name}/${file}`), `${name}/${file} is not in the notices`);
  }
  for (const file of RENDERER_NOTICE_FILES) {
    const path = join(desktopRoot, "node_modules", file);
    assert.ok(existsSync(path) && statSync(path).size > 0, `${file} does not exist`);
  }
});

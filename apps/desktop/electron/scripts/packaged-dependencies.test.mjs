import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { importedPackageName, RENDERER_BUNDLED_PACKAGES, runtimeImports } from "./packaged-dependencies.mjs";

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

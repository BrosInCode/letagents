// The "imports" field of the desktop package.json, as the packaged app gets it.
//
// In the repository an entry such as "#provider-runtime/*.js" has three
// targets: a source condition for tests, the type declarations, and the build
// output. A shipped app has only the build output. With the other targets
// left in, a `--conditions` flag or a NODE_OPTIONS variable could point the
// name at a source folder that the app does not contain, and the daemon,
// which runs the packaged program in Node mode, would fail to load its code.

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

/** Build output files that the packaged app does not run. */
export function isPackagedBuildFile(path) {
  return !/\.d\.[cm]?ts$/.test(path) && !path.endsWith(".tsbuildinfo");
}

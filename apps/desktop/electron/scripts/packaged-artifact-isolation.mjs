// Checks of the packaged app must not be able to load anything from the
// checkout that built it.
//
// The packaging script writes the artifact below apps/desktop/release. Node
// looks for package.json and node_modules in each parent folder of a file,
// so a file of an artifact in that place can find the desktop package.json
// and the development node_modules of the checkout. A dependency that is
// absent from the packaged app then still loads, and a check passes that
// fails for an installed app. So the checks run on a copy of the artifact in
// a folder with no package.json and no node_modules above it.

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

function inside(folder, path) {
  const rest = relative(folder, path);
  return rest === "" || (!rest.startsWith("..") && !rest.startsWith(sep) && !/^[A-Za-z]:/.test(rest));
}

/** The parent folders of `path` that would let Node resolve a package or an import name from outside it. */
export function resolutionRootsAbove(path) {
  const found = [];
  for (let folder = dirname(realpathSync(path)); ; folder = dirname(folder)) {
    for (const name of ["package.json", "node_modules"]) {
      if (existsSync(join(folder, name))) found.push(join(folder, name));
    }
    if (dirname(folder) === folder) return found;
  }
}

/** The symbolic links below `folder` that lead out of `bundle`. */
export function linksLeaving(bundle, folder = bundle, found = []) {
  const root = realpathSync(bundle);
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (lstatSync(path).isSymbolicLink()) {
      let target;
      try { target = realpathSync(path); } catch { target = null; }
      if (target === null || !inside(root, target)) found.push(path);
    } else if (entry.isDirectory()) {
      linksLeaving(bundle, path, found);
    }
  }
  return found;
}

/**
 * Copy the packaged bundle into a new folder outside every checkout and
 * return the copy. Fails when the copy can still reach outside code.
 */
export async function isolatePackagedBundle(bundle, { parent = tmpdir() } = {}) {
  const root = await mkdtemp(join(realpathSync(parent), "letagents-packaged-artifact-"));
  const copy = join(root, basename(bundle));
  try {
    // verbatimSymlinks: the macOS bundle has relative links inside its frameworks.
    await cp(bundle, copy, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    const roots = resolutionRootsAbove(copy);
    if (roots.length > 0) {
      throw new Error(`the copy of the packaged app at ${copy} is below ${roots.join(", ")}; Node could load code from there`);
    }
    const links = linksLeaving(copy);
    if (links.length > 0) {
      throw new Error(`the packaged app has links that lead out of it: ${links.slice(0, 5).join(", ")}`);
    }
  } catch (error) {
    // The copy is several hundred megabytes; a refused copy must not stay on disk.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    throw error;
  }
  return { root, bundle: copy };
}

import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/**
 * The folder that holds LetAgents state for this OS user (`~/.letagents`).
 * The home folder comes from os.homedir(), which reads USERPROFILE on Windows,
 * where HOME is usually not set.
 */
export function letagentsHome({ homedir = osHomedir, join: joinPath = join } = {}) {
  return joinPath(homedir(), ".letagents");
}

/** A path inside the LetAgents state folder. */
export function letagentsHomePath(...segments) {
  return join(letagentsHome(), ...segments);
}

/**
 * The Antigravity CLI keeps its Google sign-in in the OS keychain, or, when
 * the keychain does not answer in time, in a file in its own folder:
 * `<gemini dir>/antigravity-cli/antigravity-oauth-token` (seen on agy 1.5.15).
 * Each agent runs with its own `--gemini-dir`, where a keychain sign-in is
 * found but a file sign-in is not: agy then refuses `session/new` with
 * "Authentication required". So at every start the agent's folder mirrors the
 * owner's file: a link to it while it exists, and nothing when the owner has
 * none. The folder is under `~/.letagents`, which agents' file tools never open.
 */
import { copyFileSync, linkSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { protectOwnerPrivateSync } from "../../../../../shared/owner-private-fs.mjs";

export const ANTIGRAVITY_TOKEN_FILE = join("antigravity-cli", "antigravity-oauth-token");

export function ownerAntigravityTokenPath(ownerDir = join(homedir(), ".gemini")): string {
  return join(ownerDir, ANTIGRAVITY_TOKEN_FILE);
}

/** Whether the owner's sign-in is kept in agy's token file: a non-empty file, through any link. */
export function ownerAntigravityTokenFileExists(ownerDir?: string): boolean {
  try {
    const stat = statSync(ownerAntigravityTokenPath(ownerDir));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Give the agent's folder the owner's file sign-in, or take it away when the owner has none. */
export function shareAntigravitySignIn(agentDir: string, ownerDir = join(homedir(), ".gemini")): void {
  const owner = ownerAntigravityTokenPath(ownerDir);
  const agent = join(agentDir, ANTIGRAVITY_TOKEN_FILE);
  rmSync(agent, { force: true });
  if (!ownerAntigravityTokenFileExists(ownerDir)) return;
  mkdirSync(join(agentDir, "antigravity-cli"), { recursive: true, mode: 0o700 });
  try {
    symlinkSync(owner, agent);
    return;
  } catch { /* Windows without Developer Mode cannot make symbolic links. */ }
  try {
    // A hard link needs no privilege and still shares the owner's file.
    linkSync(owner, agent);
    return;
  } catch { /* another volume */ }
  // Last: a copy, made private to the owner like the other agent credentials.
  copyFileSync(owner, agent);
  protectOwnerPrivateSync(agent, "file");
}

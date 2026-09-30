export const SCRATCH_WORKSPACE_BRANCH: "main";
export const RETAINED_REPLACED_ENTRIES: number;
/** Makes a room's scratch workspace the root of its own empty Git repository. */
export function ensureScratchWorkspaceRepository(
  workspace: string,
  options?: { exclude?: readonly string[] },
): Promise<"created" | "present" | "replaced">;
/** Null when Git, run with this environment, takes the workspace as a repository. */
export function probeScratchWorkspaceGit(
  workspace: string,
  environment: Record<string, string | undefined>,
  options?: { timeoutMs?: number; platform?: string; xcodeSelect?: string },
): Promise<string | null>;

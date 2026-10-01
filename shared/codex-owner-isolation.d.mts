export const CODEX_OWNER_FEATURE_OVERRIDES: readonly string[];
export const LETAGENTS_MCP_SERVER_NAME: "letagents";

export type CodexMcpListRunner = (
  codexBin: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => Promise<string>;

export function codexHomeDirectory(env: NodeJS.ProcessEnv): string;
export function codexPersonalSkillFiles(env: NodeJS.ProcessEnv): Promise<string[]>;
export function codexSkillDisableOverride(skillFiles: readonly string[]): string | null;
export function codexMcpServerDisableOverride(serverNames: readonly string[]): string | null;
export const runCodexMcpList: CodexMcpListRunner;
export function listCodexMcpServerNames(
  codexBin: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv; configOverrides: readonly string[] },
  run?: CodexMcpListRunner,
): Promise<string[]>;
export function codexOwnerIsolationOverrides(
  codexBin: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv; configOverrides?: readonly string[] },
  run?: CodexMcpListRunner,
): Promise<string[]>;

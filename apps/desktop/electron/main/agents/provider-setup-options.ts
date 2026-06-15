import type {
  DesktopAgentProviderSetupInput,
  DesktopMcpInstallOptions,
} from "../../ipc-types.js";

export function agentProviderMcpInstallOptions(
  input: Pick<DesktopAgentProviderSetupInput, "repoRootPath">,
): DesktopMcpInstallOptions {
  const cwd = input.repoRootPath?.trim() || null;
  return cwd ? { cwd } : {};
}

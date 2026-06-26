import type {
  DesktopAgentProvider,
  DesktopAgentProviderSetupAction,
  DesktopAgentProviderSetupResult,
} from "../../ipc-types.js";

export function providerSetupConfirmationResult(
  provider: Pick<DesktopAgentProvider, "id" | "name">,
  action: DesktopAgentProviderSetupAction,
): DesktopAgentProviderSetupResult {
  const name = provider.name.trim() || "Agent";
  if (action === "install_runtime") {
    return {
      providerId: provider.id,
      action,
      success: false,
      message: `${name} install requires confirmation.`,
      detail: provider.id === "codex"
        ? "LetAgents will install the official Codex CLI runtime only after the user confirms this action."
        : `LetAgents will install the official ${name} runtime only after the user confirms this action.`,
    };
  }

  return {
    providerId: provider.id,
    action,
    success: false,
    message: `${name} connection install requires confirmation.`,
    detail: "LetAgents will update this provider's agent app configuration only after the user confirms this action.",
  };
}

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
      detail: `LetAgents will install its managed ${name} execution engine only after the user confirms this action. External provider CLIs remain user-managed.`,
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

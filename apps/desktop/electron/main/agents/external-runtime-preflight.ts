import type {
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
} from "../../ipc-types.js";

export function missingExternalRuntimePreflight(
  provider: DesktopAgentProvider,
  mcpStatus: DesktopAgentProviderPreflight["mcpStatus"],
): DesktopAgentProviderPreflight {
  const hasInstallRoute = Boolean(
    provider.runtimeInstallCommand?.trim() || provider.runtimeInstallUrl?.trim(),
  );
  if (!hasInstallRoute) {
    return {
      providerId: provider.id,
      status: "error",
      canStart: false,
      message: `${provider.name} installation guidance is unavailable.`,
      detail: "This provider is missing both an install command and an installation guide. Update LetAgents or contact support.",
      nextAction: null,
      version: null,
      mcpStatus,
    };
  }
  return {
    providerId: provider.id,
    status: "missing_runtime",
    canStart: false,
    message: `${provider.name} is not installed.`,
    detail: `Install and sign in to the official ${provider.name} CLI, then choose Check again. LetAgents does not install or update external provider CLIs.`,
    nextAction: "install_external_runtime",
    version: null,
    mcpStatus,
  };
}

import type {
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
} from "../../../../../electron/ipc-types";

export type DesktopMcpWizardStep = "choose" | "install" | "done";
export type FirstRunWizardStage = "welcome" | "mcp" | "github" | "room" | "agent";

export interface FirstRunAgentOption {
  provider: DesktopAgentProvider;
  preflight: DesktopAgentProviderPreflight | null;
  error: string | null;
}

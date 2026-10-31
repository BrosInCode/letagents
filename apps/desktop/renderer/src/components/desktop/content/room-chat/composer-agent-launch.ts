import type { InjectionKey } from "vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopGitRoomInfo,
  RepoStatus,
} from "../../../../../../electron/ipc-types";

/** What the room shell knows that an agent started from the composer needs. */
export interface ComposerAgentLaunchContext {
  roomStorageMode?: "local" | "cloud";
  roomGitRoom: DesktopGitRoomInfo | null;
  repoRootPath: string | null;
  repoStatus: RepoStatus | null;
  gitRoomMatchesActiveRepo: boolean;
  viewerLogin: string | null;
}

export interface ComposerAgentLaunchHost {
  context: () => ComposerAgentLaunchContext;
  /** Opens the Add agent window, at one provider or on the Open Model settings. */
  openAddAgent: (options?: { providerId?: DesktopAgentProviderId; section?: "open-model" }) => void;
  /** Switches the room to a checkout, as the Add agent window's worktree picker does. */
  chooseWorktree: (rootPath: string) => void;
}

export const composerAgentLaunchKey: InjectionKey<ComposerAgentLaunchHost> = Symbol("composer-agent-launch");

/** The providers the "Add agent" submenu lists by name, in this order. */
export const COMPOSER_AGENT_PROVIDERS: readonly DesktopAgentProviderId[] = ["claude-code", "codex", "open-model", "cursor"];

export function composerAgentName(provider: Pick<DesktopAgentProvider, "id" | "name"> | null | undefined): string {
  if (!provider) return "Agent";
  return provider.id === "claude-code" ? "Claude" : provider.name;
}

export type ComposerAgentReadiness =
  /** Still checking; the chip may be added and the check runs again on Enter. */
  | { state: "checking" }
  | { state: "ready" }
  /** Open Model with no endpoint or model saved yet. */
  | { state: "not_set_up" }
  /** Needs the Add agent window first, with a short word for the menu row. */
  | { state: "setup"; word: string };

/** Reads a provider check the way the submenu row and the chip need it. */
export function composerAgentReadiness(
  providerId: DesktopAgentProviderId,
  preflight: DesktopAgentProviderPreflight | null | undefined,
  options: { openModelConfigured?: boolean | null; failed?: boolean } = {},
): ComposerAgentReadiness {
  if (providerId === "open-model" && options.openModelConfigured === false) return { state: "not_set_up" };
  if (options.failed) return { state: "setup", word: "Check setup" };
  if (!preflight) return { state: "checking" };
  if (preflight.canStart) return { state: "ready" };
  if (providerId === "open-model" && preflight.status === "config_required") return { state: "not_set_up" };
  switch (preflight.status) {
    case "missing_runtime": return { state: "setup", word: "Install" };
    case "auth_required": return { state: "setup", word: "Sign in" };
    case "bridge_required":
    case "config_required":
    case "runtime_installed": return { state: "setup", word: "Set up" };
    default:
      // A room-level step (a project, a worktree) is chosen in the chip or on Enter.
      return preflight.nextAction === "choose_repo" || preflight.nextAction === "choose_worktree"
        ? { state: "ready" }
        : { state: "setup", word: "Check setup" };
  }
}

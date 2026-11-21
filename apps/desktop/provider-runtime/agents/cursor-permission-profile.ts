import type {
  DesktopManagedAgentPermissionProfileId,
} from "../../ipc-types.js";
import type {
  CursorReadOnlyMode,
  CursorSandboxMode,
} from "./cursor-runner.js";
import { cursorOsSandbox } from "./cursor-sandbox-policy.js";

/** What the user sees where Cursor is chosen on Windows (renderer copy keeps the same words). */
export const CURSOR_WINDOWS_UNSANDBOXED_NOTICE =
  "On Windows, Cursor runs without an operating-system sandbox. LetAgents still limits it to this room's folder and permissions.";

export interface CursorPermissionLaunchOptions {
  mode: CursorReadOnlyMode | null;
  force: boolean;
  sandbox: CursorSandboxMode | null;
}

export function cursorLaunchOptionsForPermissionProfile(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
): CursorPermissionLaunchOptions {
  switch (normalizeCursorPermissionProfileId(profileId)) {
    case "sandboxed_write":
      return {
        mode: null,
        force: true,
        sandbox: "enabled",
      };
    case "full_access":
      return {
        mode: null,
        force: true,
        sandbox: "disabled",
      };
    default:
      return {
        mode: "ask",
        force: false,
        sandbox: null,
      };
  }
}

export function cursorPermissionProfileInstructionLines(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  switch (normalizeCursorPermissionProfileId(profileId)) {
    case "sandboxed_write":
      return [
        "- You may edit files and run local commands when the room event requires implementation work.",
        "- Keep changes scoped to the selected repository/workspace and respect Cursor sandbox failures instead of trying to bypass them.",
        "- LetAgents carries ordinary nonignored file edits back after the turn. Do not create commits, switch branches, or rely on ignored build output being persisted.",
        cursorOsSandbox(platform) === "windows-unsandboxed"
          ? "- This computer runs Windows, where no operating-system sandbox limits your commands. Stay inside the workspace, do not use the network, and ask a teammate or the owner to commit, push and open the pull request."
          : "- In this mode there is no network. git and gh usually fail inside the workspace, for example with an Xcode license error. This is caused by the sandbox, so do not report it as a problem with the owner's Mac. Ask a teammate or the owner to commit, push and open the pull request.",
        "- The Cursor sandbox does not prove that MCP tools are sandboxed; use only tools exposed by this runtime and allowed by the human's request.",
        "- Avoid destructive commands, secrets, keychains, global config, and LetAgents local state unless the human explicitly asks.",
      ];
    case "full_access":
      return [
        "- You may edit files and run local commands when the room event requires implementation work.",
        "- Full access permits filesystem and network operations outside the working directory when needed for the human's request.",
        "- Changes apply directly to the working directory. You may create commits, push branches, and open pull requests with available credentials when the task calls for it.",
        "- Avoid destructive commands, secrets, keychains, global config, and LetAgents local state unless the human explicitly asks.",
      ];
    default:
      return [
        "- Do not edit files, run write-capable actions, or try to bypass read-only mode. If the event requires code changes, explain the needed change instead of making it.",
        "- If action is useful, inspect/analyze locally as allowed by Cursor read-only mode and make your final answer the public room reply the desktop should publish as you.",
      ];
  }
}

export function cursorPermissionProfileReadyDetail(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const windowsNotice = cursorOsSandbox(platform) === "windows-unsandboxed" ? ` ${CURSOR_WINDOWS_UNSANDBOXED_NOTICE}` : "";
  switch (normalizeCursorPermissionProfileId(profileId)) {
    case "sandboxed_write":
      return windowsNotice
        ? `Cursor edits a separate copy of your project. LetAgents checks for conflicts before copying changes back, and Git history is kept.${windowsNotice}`
        : "Cursor edits a separate copy of your project with restricted file and command access. LetAgents checks for conflicts before copying changes back. Files ignored by Git stay read-only, and Git history is kept.";
    case "full_access":
      return "Cursor changes files directly and runs commands without approval prompts. It can access files outside the project and use the network, including Git pushes and pull requests with available credentials. LetAgents manages room messages and Cursor sign-in separately.";
    default:
      return `Cursor can inspect the selected workspace but cannot edit it.${windowsNotice}`;
  }
}

export function normalizeCursorPermissionProfileId(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
): DesktopManagedAgentPermissionProfileId {
  const normalized = String(profileId ?? "").trim() as DesktopManagedAgentPermissionProfileId;
  return normalized || "read_only";
}

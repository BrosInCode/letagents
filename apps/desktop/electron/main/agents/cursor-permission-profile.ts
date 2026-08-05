import type {
  DesktopManagedAgentPermissionProfileId,
} from "../../ipc-types.js";
import type {
  CursorReadOnlyMode,
  CursorSandboxMode,
} from "./cursor-runner.js";

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

export function cursorPermissionProfileRuntimeLine(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
): string {
  switch (normalizeCursorPermissionProfileId(profileId)) {
    case "sandboxed_write":
      return "Runtime mode: Cursor sandboxed write. Cursor is launched with --force and --sandbox enabled; exposed MCP tools remain governed separately by the runtime.";
    case "full_access":
      return "Runtime mode: Cursor full access. Cursor is launched with --force and --sandbox disabled.";
    case "ask_before_write":
      return "Runtime mode: Cursor ask-before-write is not enabled here; treat this session as read-only.";
    default:
      return "Runtime mode: Cursor read-only. You are running in ask mode and must not edit files.";
  }
}

export function cursorPermissionProfileInstructionLines(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
): string[] {
  switch (normalizeCursorPermissionProfileId(profileId)) {
    case "sandboxed_write":
      return [
        "- You may edit files and run local commands when the room event requires implementation work.",
        "- Keep changes scoped to the selected repository/workspace and respect Cursor sandbox failures instead of trying to bypass them.",
        "- The Cursor sandbox does not prove that MCP tools are sandboxed; use only tools exposed by this runtime and allowed by the human's request.",
        "- Avoid destructive commands, secrets, keychains, global config, and LetAgents local state unless the human explicitly asks.",
      ];
    case "full_access":
      return [
        "- You may edit files and run local commands when the room event requires implementation work.",
        "- Keep all local changes inside the selected repository/workspace. If broader changes are needed, explain the boundary instead of trying to bypass it.",
        "- Avoid destructive commands, secrets, keychains, global config, and LetAgents local state unless the human explicitly asks.",
      ];
    default:
      return [
        "- Do not edit files, run write-capable actions, or try to bypass read-only mode. If the event requires code changes, explain the needed change instead of making it.",
        "- If action is useful, inspect/analyze locally as allowed by Cursor read-only mode and make your final answer the public room reply the desktop should publish as you.",
      ];
  }
}

export function cursorPermissionProfileStartMessage(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
): string {
  switch (normalizeCursorPermissionProfileId(profileId)) {
    case "sandboxed_write":
      return "Cursor sandboxed-write agent started with desktop-delivered room events.";
    case "full_access":
      return "Cursor full-access agent started with desktop-delivered room events.";
    default:
      return "Cursor read-only agent started with desktop-delivered room events.";
  }
}

export function cursorPermissionProfileReadyDetail(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
  supervised = false,
): string {
  switch (normalizeCursorPermissionProfileId(profileId)) {
    case "sandboxed_write":
      if (supervised) {
        return "Cursor can read, edit, and run normal development commands inside the selected workspace. Cursor's sandbox and the independent LetAgents host boundary remain enabled.";
      }
      return "Cursor will run with --force and Cursor sandbox enabled for write-capable local work. Selected MCP tools still follow the chosen MCP policy.";
    case "full_access":
      if (supervised) {
        return "Cursor's inner sandbox is disabled for repository tool compatibility, while the independent LetAgents boundary still confines local writes to the selected workspace and blocks host authority.";
      }
      return "Cursor will run with --force and Cursor sandbox disabled for trusted local work. Selected MCP tools still follow the chosen MCP policy.";
    default:
      return supervised
        ? "Cursor can inspect the selected workspace but cannot edit it."
        : "Cursor will run in ask mode for read-only local analysis.";
  }
}

export function normalizeCursorPermissionProfileId(
  profileId: DesktopManagedAgentPermissionProfileId | null | undefined,
): DesktopManagedAgentPermissionProfileId {
  const normalized = String(profileId ?? "").trim() as DesktopManagedAgentPermissionProfileId;
  return normalized || "read_only";
}

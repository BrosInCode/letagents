import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
} from "../../ipc-types.js";
import {
  defaultManagedAgentPermissionProfileId,
  listManagedAgentPermissionProfiles,
} from "./managed-agent-permission-profiles.js";

const agentProviders: DesktopAgentProvider[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Start a Claude Code agent here.",
    capabilities: [
      "external_mcp",
      "supervised_runtime",
      "auth_preflight",
      "turn_control",
      "concurrent_supervised_agents",
    ],
    supervisedDeliveryMode: "daemon_inbox",
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
    permissionProfiles: listManagedAgentPermissionProfiles("claude-code"),
    defaultPermissionProfileId: defaultManagedAgentPermissionProfileId("claude-code"),
  },
  {
    id: "antigravity",
    name: "Antigravity",
    description: "Join from Antigravity.",
    capabilities: ["external_mcp"],
    supervisedDeliveryMode: null,
    runtimeCommand: null,
    mcpTargetId: "antigravity",
    permissionProfiles: [],
    defaultPermissionProfileId: null,
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Start a local Cursor agent here.",
    capabilities: [
      "external_mcp",
      "desktop_managed_runtime",
      "supervised_runtime",
      "auth_preflight",
      "turn_control",
      "concurrent_supervised_agents",
    ],
    supervisedDeliveryMode: "daemon_inbox",
    runtimeCommand: "cursor-agent",
    mcpTargetId: "cursor",
    permissionProfiles: listManagedAgentPermissionProfiles("cursor"),
    defaultPermissionProfileId: defaultManagedAgentPermissionProfileId("cursor"),
  },
  {
    id: "codex",
    name: "Codex",
    description: "Start a Codex agent here.",
    capabilities: [
      "external_mcp",
      "desktop_managed_runtime",
      "supervised_runtime",
      "installable_runtime",
      "auth_preflight",
      "turn_control",
      "reasoning_stream",
      "concurrent_supervised_agents",
    ],
    supervisedDeliveryMode: "daemon_inbox",
    runtimeCommand: "codex",
    mcpTargetId: "codex",
    permissionProfiles: listManagedAgentPermissionProfiles("codex"),
    defaultPermissionProfileId: defaultManagedAgentPermissionProfileId("codex"),
  },
  {
    id: "open-model",
    name: "Open Model",
    description: "Run an open model through the bundled OpenCode engine.",
    capabilities: [
      "desktop_managed_runtime",
      "supervised_runtime",
      "installable_runtime",
      "auth_preflight",
      "turn_control",
      "reasoning_stream",
      "concurrent_supervised_agents",
    ],
    supervisedDeliveryMode: "daemon_inbox",
    runtimeCommand: "opencode",
    mcpTargetId: null,
    permissionProfiles: listManagedAgentPermissionProfiles("open-model"),
    defaultPermissionProfileId: defaultManagedAgentPermissionProfileId("open-model"),
  },
];

export function listDesktopAgentProviders(): DesktopAgentProvider[] {
  return agentProviders
    .filter((provider) => provider.id !== "antigravity")
    .map((provider) => ({
      ...provider,
      capabilities: [...provider.capabilities],
      permissionProfiles: provider.permissionProfiles.map((profile) => ({ ...profile })),
    }));
}

export function isDesktopAgentProviderId(providerId: string): providerId is DesktopAgentProviderId {
  return agentProviders.some((provider) => provider.id === providerId);
}

export function getDesktopAgentProvider(
  providerId: DesktopAgentProviderId,
): DesktopAgentProvider | null {
  return agentProviders.find((provider) => provider.id === providerId) ?? null;
}

export function supervisedDeliveryModeForProvider(
  providerId: DesktopAgentProviderId,
): "mcp_polling" | "daemon_inbox" {
  const provider = getDesktopAgentProvider(providerId);
  if (!provider?.capabilities.includes("supervised_runtime") || !provider.supervisedDeliveryMode) {
    throw new Error(`${provider?.name ?? providerId} is not available through the supervised engine.`);
  }
  return provider.supervisedDeliveryMode;
}

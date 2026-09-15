import { Activity, ArchiveRestore, Bot, CircleUser, Cloud, CloudUpload, Database, GitBranch, Handshake, KeyRound, ServerCog, SlidersHorizontal, Sparkles, Trash2, Wrench } from "@lucide/vue";
import type { SettingsNavGroup, SettingsNavItem, SettingsPaneId } from "./types";

export const settingsNavGroups: SettingsNavGroup[] = [
  { label: "You", items: [
    { id: "account:profile", title: "Account", description: "Your identity and GitHub connection", icon: CircleUser },
    { id: "account:renting", title: "Renting", description: "Availability and agent rentals", icon: Handshake },
  ] },
  { label: "Workspace", items: [
    { id: "rooms:defaults", title: "Rooms", description: "Manage rooms, pins, and access", icon: SlidersHorizontal },
    { id: "storage:chat", title: "Storage", description: "Local data and cloud publishing", icon: Cloud },
    { id: "system:agents", title: "Agents", description: "Agent status and availability", icon: Bot },
    { id: "system:mcp", title: "Connections", description: "Connect your existing agent apps", icon: ServerCog },
  ] },
  { label: "Application", items: [
    { id: "system:app-agent", title: "Assistant", description: "Choose how the app assistant helps you", icon: Sparkles },
    { id: "system:updates", title: "Updates", description: "Version and available updates", icon: CloudUpload },
    { id: "system:diagnostics", title: "Troubleshooting", description: "Health, technical details, and recovery", icon: Activity },
  ] },
];

export const settingsSubsections: Partial<Record<SettingsPaneId, SettingsNavItem[]>> = {
  "rooms:defaults": [
    settingsNavGroups[1].items[0],
    { id: "rooms:left", title: "Left rooms", description: "Restore rooms you previously left", icon: ArchiveRestore },
    { id: "rooms:danger", title: "Remove rooms", description: "Leave or delete rooms you created", icon: Trash2 },
  ],
  "storage:chat": [
    { id: "storage:chat", title: "Preferences", description: "Choose where new rooms store their data", icon: Cloud },
    { id: "storage:sync", title: "Publishing", description: "Publish a local room to the cloud", icon: CloudUpload },
    { id: "storage:database", title: "Local files", description: "Find your database and attachments", icon: Database },
  ],
  "system:mcp": [
    { id: "system:mcp", title: "Connected apps", description: "Agent apps connected through MCP", icon: ServerCog },
    { id: "system:setup", title: "Connect an app", description: "Set up LetAgents in an existing agent app", icon: Wrench },
  ],
  "system:diagnostics": [
    { id: "system:diagnostics", title: "Health", description: "Check local state and recovery actions", icon: Activity },
    { id: "system:runtime", title: "Technical details", description: "Application, repository, and runtime information", icon: GitBranch },
    { id: "system:supervisor", title: "Cloud access", description: "Advanced cloud authorization and credential recovery", icon: KeyRound },
  ],
};

export function settingsSectionFor(pane: SettingsPaneId): SettingsPaneId {
  for (const [section, items] of Object.entries(settingsSubsections)) {
    if (items.some(item => item.id === pane)) return section as SettingsPaneId;
  }
  return pane;
}

export function filterSettingsNavigation(query: string): SettingsNavGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return settingsNavGroups;
  const matches = (parts: string[]) => words.every(word => parts.join(" ").toLowerCase().includes(word));
  return settingsNavGroups.map(group => ({ ...group, items: group.items.flatMap(item => {
    if (matches([group.label, item.title])) return [item];
    const children = (settingsSubsections[item.id] ?? []).filter(child =>
      matches([group.label, item.title, child.title, child.description]));
    return children.length ? children : matches([group.label, item.title, item.description]) ? [item] : [];
  }) })).filter(group => group.items.length);
}

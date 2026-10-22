import { Activity, ArchiveRestore, Bot, CircleUser, Cloud, CloudUpload, Database, GitBranch, Handshake, KeyRound, Plug, ServerCog, SlidersHorizontal, Sparkles, Ticket, Trash2, Wrench } from "@lucide/vue";
import type { LegacySettingsPaneId, SettingsNavGroup, SettingsNavItem, SettingsPaneId } from "./types";

export const settingsNavGroups: SettingsNavGroup[] = [
  { label: "You", items: [
    { id: "account:profile", title: "Account", description: "Your identity and GitHub connection", icon: CircleUser },
    { id: "account:renting", title: "Renting", description: "Availability and agent rentals", icon: Handshake },
    { id: "account:connectors", title: "Connectors", description: "Connect trackers, agent apps and remote sign-ins", icon: Plug },
  ] },
  { label: "Workspace", items: [
    { id: "rooms:defaults", title: "Rooms", description: "Manage rooms, pins, and access", icon: SlidersHorizontal },
    { id: "storage:chat", title: "Storage", description: "Local data and cloud publishing", icon: Cloud },
    { id: "system:agents", title: "Agents", description: "Agent status and availability", icon: Bot },
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
  "account:connectors": [
    { id: "account:connectors", title: "Trackers", description: "Jira, Linear and GitHub Issues for your boards", icon: Ticket },
    { id: "account:connectors-agents", title: "Agent apps", description: "Agent apps connected through MCP", icon: ServerCog },
    { id: "account:connectors-remote", title: "Remote sign-ins", description: "Apps signed in through the remote MCP connector", icon: Cloud },
    {
      id: "account:connectors-setup",
      title: "Connect an agent app",
      description: "Set up LetAgents in an existing agent app",
      icon: Wrench,
      hidden: true,
      parent: "account:connectors-agents",
    },
  ],
  "system:diagnostics": [
    { id: "system:diagnostics", title: "Health", description: "See the background service and agents across all rooms", icon: Activity },
    { id: "system:runtime", title: "Technical details", description: "Application, repository, and runtime information", icon: GitBranch },
    { id: "system:supervisor", title: "Cloud access", description: "Advanced cloud authorization and credential recovery", icon: KeyRound },
  ],
};

/** Where each old pane id opens now. Deep links and saved state keep working. */
export const legacySettingsPaneRedirects: Readonly<Record<LegacySettingsPaneId, SettingsPaneId>> = {
  "system:mcp": "account:connectors-agents",
  "system:setup": "account:connectors-setup",
  "system:remote-mcp": "account:connectors-remote",
};

/** A pane id as it opens today: an old id goes to the pane that replaced it. */
export function resolveSettingsPane(pane: SettingsPaneId | LegacySettingsPaneId): SettingsPaneId {
  return (legacySettingsPaneRedirects as Record<string, SettingsPaneId>)[pane] ?? pane as SettingsPaneId;
}

/** The sub-navigation items of a section; hidden panes are left out. */
export function visibleSettingsSubsections(section: SettingsPaneId): SettingsNavItem[] {
  return (settingsSubsections[section] ?? []).filter(item => !item.hidden);
}

/** The sub-navigation item to mark as current: a hidden pane marks its parent. */
export function settingsSubsectionFor(pane: SettingsPaneId): SettingsPaneId {
  const section = settingsSectionFor(pane);
  return settingsSubsections[section]?.find(item => item.id === pane)?.parent ?? pane;
}

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

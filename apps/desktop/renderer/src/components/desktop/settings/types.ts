import type { Component } from "vue";

export type SettingsPaneId =
  | "account:profile"
  | "account:renting"
  | "account:connectors"
  | "account:connectors-agents"
  | "account:connectors-setup"
  | "account:connectors-remote"
  | "rooms:defaults"
  | "rooms:left"
  | "rooms:danger"
  | "storage:chat"
  | "storage:sync"
  | "storage:database"
  | "system:app-agent"
  | "system:supervisor"
  | "system:runtime"
  | "system:updates"
  | "system:agents"
  | "system:diagnostics";

/** Pane ids from before the Connectors page. They still open, at the page that replaced them. */
export type LegacySettingsPaneId = "system:mcp" | "system:setup" | "system:remote-mcp";

export interface SettingsNavItem {
  id: SettingsPaneId;
  title: string;
  description: string;
  icon: Component;
  /** Reached from search and from links in the page, not from the sub-navigation. */
  hidden?: boolean;
  /** The sub-navigation item to mark as current while this hidden pane is open. */
  parent?: SettingsPaneId;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export type SettingsFeedback = {
  message: string;
  state: "error" | "info" | "success";
};

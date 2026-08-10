import type { Component } from "vue";

export type SettingsPaneId =
  | "account:profile"
  | "account:renting"
  | "rooms:defaults"
  | "rooms:left"
  | "rooms:danger"
  | "storage:chat"
  | "storage:sync"
  | "storage:database"
  | "system:setup"
  | "system:app-agent"
  | "system:supervisor"
  | "system:runtime"
  | "system:mcp"
  | "system:agents"
  | "system:diagnostics";

export interface SettingsNavItem {
  id: SettingsPaneId;
  title: string;
  description: string;
  icon: Component;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export type SettingsFeedback = {
  message: string;
  state: "error" | "info" | "success";
};

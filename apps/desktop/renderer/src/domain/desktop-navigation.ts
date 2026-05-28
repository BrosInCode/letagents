import type { SystemEntry } from "../components/desktop/types";

export const setupEntry: SystemEntry = {
  id: "system:setup",
  type: "system",
  title: "Setup",
  description: "Install LetAgents",
  sectionLabel: "System",
};

export const repositoryEntry: SystemEntry = {
  id: "system:repos",
  type: "system",
  title: "Room details",
  description: "Branches and related rooms",
  sectionLabel: "System",
};

export const workersEntry: SystemEntry = {
  id: "system:workers",
  type: "system",
  title: "Agents",
  description: "Status and availability",
  sectionLabel: "System",
};

export const settingsEntry: SystemEntry = {
  id: "system:settings",
  type: "system",
  title: "Settings",
  description: "Account and rooms",
  sectionLabel: "System",
};

export const diagnosticsEntry: SystemEntry = {
  id: "system:diagnostics",
  type: "system",
  title: "Diagnostics",
  description: "Local truth and recovery",
  sectionLabel: "System",
};

export const systemEntries: SystemEntry[] = [
  setupEntry,
  repositoryEntry,
  workersEntry,
  settingsEntry,
  diagnosticsEntry,
];

import type { MarketplaceEntry, NeedsYouEntry, SystemEntry } from "../components/desktop/types";

export const rentMarketplaceEntry: MarketplaceEntry = {
  id: "marketplace:rent",
  type: "marketplace",
  title: "Rent",
  description: "Borrow or share an available agent",
  sectionLabel: "LetAgents",
};

export const setupEntry: SystemEntry = {
  id: "system:setup",
  type: "system",
  title: "Setup",
  description: "Install LetAgents",
  sectionLabel: "System",
};

export const appAgentEntry: SystemEntry = {
  id: "system:app-agent",
  type: "system",
  title: "App Agent",
  description: "Help using LetAgents",
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
  appAgentEntry,
  repositoryEntry,
  workersEntry,
  settingsEntry,
  diagnosticsEntry,
];

export const needsYouEntry: NeedsYouEntry = { id: "inbox:needs-you", type: "inbox", title: "Inbox", description: "Requests and updates across your rooms", sectionLabel: "LetAgents" };

/**
 * Open the room behind an Inbox item. A room the sidebar lists opens at once,
 * as a click there does, and loads in place; only a room it does not list
 * waits for its snapshot before the view changes.
 */
export async function openInboxRoom<Entry>(roomIdentifier: string, navigation: {
  findEntry: (roomIdentifier: string) => Entry | null;
  selectEntry: (entry: Entry) => void;
  openBySnapshot: (roomIdentifier: string) => Promise<void>;
}): Promise<void> {
  const entry = navigation.findEntry(roomIdentifier);
  if (entry) navigation.selectEntry(entry);
  else await navigation.openBySnapshot(roomIdentifier);
}

/**
 * Remembers the room an Inbox item opened in place, so a failed load of that
 * room is reported once instead of leaving its placeholder in silence. Loads
 * the Inbox did not start are left as they were.
 */
export function inboxRoomOpenReporter(report: (error: unknown) => void) {
  let pending: string | null = null;
  return {
    opened(entryId: string): void { pending = entryId; },
    async load<T>(entryId: string, load: () => Promise<T>): Promise<T> {
      const fromInbox = pending === entryId;
      if (fromInbox) pending = null;
      try { return await load(); }
      catch (error) {
        if (fromInbox) report(error);
        throw error;
      }
    },
  };
}

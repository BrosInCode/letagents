import {
  CONNECTORS_NOT_CONFIGURED_MESSAGE,
  trackerProviderLabel,
  type TicketState,
  type TrackerConnectionView,
  type TrackerProvider,
  type TrackerProviderAvailability,
} from "../../../../../../../shared/ticket-connectors.mjs";
import type { DesktopMcpInstallTarget } from "../../../../../electron/ipc-types";
import type { SettingsPaneId } from "./types";

export const ticketStateOptions: Array<{ value: TicketState; label: string }> = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
];

export function trackerLabel(provider: TrackerProvider): string {
  return trackerProviderLabel(provider);
}

export function ticketStateLabel(state: TicketState): string {
  return ticketStateOptions.find((option) => option.value === state)?.label ?? state;
}

export interface StatusMapRow {
  name: string;
  state: TicketState;
  /** Seen in the tracker with no map entry; shown as in progress until saved. */
  unmapped: boolean;
}

/** Linear `type:<type>` keys read as "Any <type> status" in the editor. */
export function statusMapRowLabel(name: string): string {
  const type = /^type:(.+)$/.exec(name)?.[1];
  return type ? `Any ${type} status` : name;
}

/** The map as editor rows: unmapped statuses first, so they are fixed first. */
export function statusMapRows(connection: TrackerConnectionView): StatusMapRow[] {
  const mapped = Object.entries(connection.status_map).map(([name, state]) => ({ name, state, unmapped: false }));
  const known = new Set(mapped.map((row) => row.name.toLowerCase()));
  const unmapped = connection.unmapped_statuses
    .filter((name) => !known.has(name.toLowerCase()))
    .map((name) => ({ name, state: "in_progress" as TicketState, unmapped: true }));
  return [...unmapped, ...mapped];
}

export function statusMapFromRows(rows: StatusMapRow[]): Record<string, TicketState> {
  const map: Record<string, TicketState> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) map[name] = row.state;
  }
  return map;
}

export function connectionStateLabel(connection: TrackerConnectionView): { label: string; state: string } {
  if (connection.status === "needs_reauth") return { label: "Reconnect", state: "failed" };
  if (connection.status === "error") return { label: "Error", state: "away" };
  return { label: "Connected", state: "connected" };
}

/** The three kinds of connector on the Connectors page. */
export type ConnectorKind = "tracker" | "agent_app" | "remote";
export type ConnectorStatus = "connected" | "not_connected" | "needs_attention";

/** One row of the Connectors list. `pane` is where its details are. */
export interface ConnectorRow {
  id: string;
  name: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  detail: string;
  pane: SettingsPaneId;
}

/** What the Add catalog offers. */
export type ConnectorCatalogId = TrackerProvider | "agent_app" | "remote";

export interface ConnectorCatalogEntry {
  id: ConnectorCatalogId;
  name: string;
  kind: ConnectorKind;
  description: string;
  /** Null when it can be added; else why not, in plain words. */
  unavailable: string | null;
}

const KIND_LABELS: Record<ConnectorKind, string> = {
  tracker: "Tracker",
  agent_app: "Agent app",
  remote: "Remote sign-in",
};

const STATUS_LABELS: Record<ConnectorStatus, string> = {
  connected: "Connected",
  not_connected: "Not connected",
  needs_attention: "Needs attention",
};

/** The state-pill tone for each status. */
const STATUS_TONES: Record<ConnectorStatus, string> = {
  connected: "connected",
  not_connected: "idle",
  needs_attention: "away",
};

export function connectorKindLabel(kind: ConnectorKind): string {
  return KIND_LABELS[kind];
}

export function connectorStatusLabel(status: ConnectorStatus): string {
  return STATUS_LABELS[status];
}

export function connectorStatusTone(status: ConnectorStatus): string {
  return STATUS_TONES[status];
}

/** What the server says about each tracker; null while unknown. */
export interface TrackerAvailability {
  /** The server has no connector key: nothing can be connected. */
  notConfigured: boolean;
  providers: Partial<Record<TrackerProvider, TrackerProviderAvailability>> | null;
}

/** A remote sign-in as the Connectors list needs it. */
export interface RemoteSignInSummary {
  id: string;
  client_name: string | null;
  last_used_at: string;
}

/** Every connected or known connector, trackers first. */
export function connectorRows(input: {
  trackers: readonly TrackerConnectionView[];
  agentApps: readonly Pick<DesktopMcpInstallTarget, "id" | "name" | "status" | "configIssue">[];
  remoteSignIns: readonly RemoteSignInSummary[];
}): ConnectorRow[] {
  const trackers = input.trackers.map((connection): ConnectorRow => ({
    id: connection.id,
    name: `${trackerLabel(connection.provider)} · ${connection.display_name}`,
    kind: "tracker",
    status: connection.status === "active" ? "connected" : "needs_attention",
    detail: connection.status === "active"
      ? connection.tracker_user_label ? `Signed in as ${connection.tracker_user_label}` : "Signed in"
      : connection.last_error ?? "Connect it again.",
    pane: "account:connectors",
  }));
  const agentApps = input.agentApps.map((target): ConnectorRow => ({
    id: `agent:${target.id}`,
    name: target.name,
    kind: "agent_app",
    status: target.status === "installed" ? "connected" : target.status === "needs_attention" ? "needs_attention" : "not_connected",
    detail: target.status === "needs_attention"
      ? target.configIssue ?? "Its LetAgents setup needs a fix."
      : target.status === "installed" ? "LetAgents is set up in this app." : "LetAgents is not set up in this app.",
    pane: "account:connectors-agents",
  }));
  const remote = input.remoteSignIns.map((connection): ConnectorRow => ({
    id: `remote:${connection.id}`,
    name: connection.client_name ?? "Unnamed app",
    kind: "remote",
    status: "connected",
    detail: "Signed in through the remote connector.",
    pane: "account:connectors-remote",
  }));
  return [...trackers, ...agentApps, ...remote];
}

/** The Add catalog. Trackers say why they cannot be added on this server. */
export function connectorCatalog(availability: TrackerAvailability): ConnectorCatalogEntry[] {
  const trackerBlocked = (provider: TrackerProvider): string | null => {
    if (availability.notConfigured) return CONNECTORS_NOT_CONFIGURED_MESSAGE;
    if (provider === "github" && availability.providers && !availability.providers.github?.github_app) {
      return "This server has no GitHub App, so GitHub Issues is not available.";
    }
    return null;
  };
  return [
    { id: "jira", name: "Jira", kind: "tracker", description: "Jira Cloud issues, with OAuth or an API token.", unavailable: trackerBlocked("jira") },
    { id: "linear", name: "Linear", kind: "tracker", description: "Linear issues, with OAuth or an API key.", unavailable: trackerBlocked("linear") },
    {
      id: "github",
      name: "GitHub Issues",
      kind: "tracker",
      description: "Issues in repositories where the LetAgents GitHub App is installed. No token to paste.",
      unavailable: trackerBlocked("github"),
    },
    { id: "agent_app", name: "Connect an agent app", kind: "agent_app", description: "Set up LetAgents in Claude Code, Codex, Cursor or Antigravity on this computer.", unavailable: null },
    { id: "remote", name: "Remote connector", kind: "remote", description: "Use LetAgents from an app that allows only remote connectors, such as the Claude app.", unavailable: null },
  ];
}

/** The remote MCP URL for this server, e.g. `https://letagents.chat/mcp`. */
export function remoteConnectorUrl(apiUrl: string | null | undefined): string {
  const base = (apiUrl ?? "").trim().replace(/\/+$/, "");
  return `${base || "https://letagents.chat"}/mcp`;
}

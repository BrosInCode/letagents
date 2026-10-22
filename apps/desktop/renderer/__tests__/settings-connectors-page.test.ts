import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

import {
  CONNECTORS_NOT_CONFIGURED_MESSAGE,
  type TrackerConnectionView,
} from "../../../../shared/ticket-connectors.mjs";
import {
  connectorCatalog,
  connectorRows,
  connectorStatusLabel,
  remoteConnectorUrl,
  type ConnectorCatalogEntry,
  type ConnectorRow,
} from "../src/components/desktop/settings/connectors.js";

let vite: ViteDevServer;
let ConnectorsOverview: Component;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ConnectorsOverview = (await vite.ssrLoadModule("/renderer/src/components/desktop/settings/ConnectorsOverview.vue")).default;
});

after(async () => {
  await vite?.close();
});

function tracker(overrides: Partial<TrackerConnectionView> = {}): TrackerConnectionView {
  return {
    id: "tcon_00000000-0000-4000-8000-000000000001",
    provider: "github",
    display_name: "BrosInCode",
    site_url: "https://github.com/BrosInCode",
    auth_kind: "github_app",
    tracker_user_id: "31524469",
    tracker_user_label: "EmmyMay",
    status_map: { Open: "todo", "Open (assigned)": "in_progress", Closed: "done" },
    unmapped_statuses: [],
    jev_linking_enabled: false,
    status: "active",
    last_error: null,
    last_verified_at: null,
    created_at: "2026-10-22T00:00:00.000Z",
    updated_at: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}

const rows = connectorRows({
  trackers: [
    tracker(),
    tracker({ id: "tcon_00000000-0000-4000-8000-000000000002", provider: "jira", display_name: "herotel", status: "needs_reauth", last_error: "Tracker answered 401" }),
  ],
  agentApps: [
    { id: "claude-code", name: "Claude Code", status: "installed", configIssue: null },
    { id: "cursor", name: "Cursor", status: "not_installed", configIssue: null },
    { id: "codex", name: "Codex", status: "needs_attention", configIssue: "The config file is not valid TOML." },
  ],
  remoteSignIns: [{ id: "mcpc_1", client_name: "Claude", last_used_at: "2026-10-22T00:00:00.000Z" }],
});

async function render(props: {
  rows: ConnectorRow[];
  catalog: ConnectorCatalogEntry[];
  notConfigured: boolean;
  loadError?: string | null;
  catalogInitiallyOpen?: boolean;
}): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(ConnectorsOverview, props) }));
}

test("the list shows each connector with its kind and one of three statuses", async () => {
  assert.deepEqual(rows.map((row) => [row.name, row.kind, row.status, row.pane]), [
    ["GitHub Issues · BrosInCode", "tracker", "connected", "account:connectors"],
    ["Jira · herotel", "tracker", "needs_attention", "account:connectors"],
    ["Claude Code", "agent_app", "connected", "account:connectors-agents"],
    ["Cursor", "agent_app", "not_connected", "account:connectors-agents"],
    ["Codex", "agent_app", "needs_attention", "account:connectors-agents"],
    ["Claude", "remote", "connected", "account:connectors-remote"],
  ]);
  assert.equal(rows[1]!.detail, "Tracker answered 401");

  const html = await render({ rows, catalog: connectorCatalog({ notConfigured: false, providers: null }), notConfigured: false });
  for (const status of ["connected", "not_connected", "needs_attention"] as const) {
    assert.ok(html.includes(`data-status="${status}"`), status);
    assert.ok(html.includes(connectorStatusLabel(status)), connectorStatusLabel(status));
  }
  for (const kind of ["Tracker", "Agent app", "Remote sign-in"]) assert.match(html, new RegExp(`<td[^>]*>${kind}</td>`), kind);
  assert.match(html, /data-state="away"[^>]*>Needs attention</);
  assert.ok(!html.includes('data-testid="settings-connectors-catalog"'), "the catalog opens only from Add connector");
});

test("Add opens a catalog of Jira, Linear, GitHub Issues, agent apps and the remote connector", async () => {
  const catalog = connectorCatalog({
    notConfigured: false,
    providers: { jira: { oauth: true, api_token: true }, linear: { oauth: false, api_token: true }, github: { oauth: false, api_token: false, github_app: true } },
  });
  assert.deepEqual(catalog.map((entry) => [entry.id, entry.kind, entry.unavailable]), [
    ["jira", "tracker", null],
    ["linear", "tracker", null],
    ["github", "tracker", null],
    ["agent_app", "agent_app", null],
    ["remote", "remote", null],
  ]);
  const html = await render({ rows: [], catalog, notConfigured: false, catalogInitiallyOpen: true });
  for (const name of ["Jira", "Linear", "GitHub Issues", "Connect an agent app", "Remote connector"]) {
    assert.ok(html.includes(`aria-label="Add ${name}"`), name);
  }
  assert.ok(html.includes("Show steps"));
  assert.ok(html.includes('data-testid="settings-connectors-empty"'));

  const noApp = connectorCatalog({ notConfigured: false, providers: { github: { oauth: false, api_token: false, github_app: false } } });
  assert.match(noApp.find((entry) => entry.id === "github")!.unavailable ?? "", /no GitHub App/);
});

test("a server without LETAGENTS_CONNECTOR_SECRET_KEY shows a friendly state, never the raw error", async () => {
  const catalog = connectorCatalog({ notConfigured: true, providers: null });
  assert.deepEqual(catalog.filter((entry) => entry.unavailable).map((entry) => entry.id), ["jira", "linear", "github"],
    "trackers cannot be added; agent apps and the remote connector still can");
  const html = await render({ rows: [], catalog, notConfigured: true, loadError: null, catalogInitiallyOpen: true });
  assert.ok(html.includes('data-testid="settings-connectors-not-configured"'));
  assert.ok(html.includes("Connectors are not enabled on this server. Ask your server admin to set LETAGENTS_CONNECTOR_SECRET_KEY."));
  assert.equal(CONNECTORS_NOT_CONFIGURED_MESSAGE, "Connectors are not enabled on this server. Ask your server admin to set LETAGENTS_CONNECTOR_SECRET_KEY.");
  for (const raw of ["Error invoking remote method", "DesktopApiError", "desktop:connectors:list", "503"]) {
    assert.ok(!html.includes(raw), raw);
  }
});

test("the remote connector steps name this server's /mcp URL", () => {
  assert.equal(remoteConnectorUrl("https://letagents.chat/"), "https://letagents.chat/mcp");
  assert.equal(remoteConnectorUrl("https://agents.herotel.example"), "https://agents.herotel.example/mcp");
  assert.equal(remoteConnectorUrl(null), "https://letagents.chat/mcp");
});

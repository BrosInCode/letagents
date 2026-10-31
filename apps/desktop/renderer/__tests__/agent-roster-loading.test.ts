import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let Roster: Component;
let Activity: Component;
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom",
    logLevel: "silent", server: { middlewareMode: true },
  });
  Roster = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/agents/AgentRoster.vue", import.meta.url)))).default;
  Activity = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/RoomActivityTabView.vue")).default;
});
after(async () => { await vite?.close(); });

const render = (component: Component, props: Record<string, unknown>) =>
  renderToString(createSSRApp({ render: () => h(component, props) }));

test("an initial roster load does not announce a confirmed empty room or zero counts", async () => {
  const html = await render(Roster, { rows: [], state: "loading" });
  assert.match(html, /Loading agents…/);
  assert.doesNotMatch(html, /No agents here yet|Agents appear here|<span>0<\/span>|Clear filters/);
});

test("a failed initial read offers Retry without claiming no agents exist", async () => {
  const html = await render(Roster, { rows: [], state: "error" });
  assert.match(html, /Agents couldn’t be loaded/);
  assert.match(html, />Retry<\/button>/);
  assert.doesNotMatch(html, /No agents here yet|Agents appear here|<span>0<\/span>/);
});

test("confirmed empty and existing web callers retain the normal empty roster", async () => {
  for (const props of [{ rows: [] }, { rows: [], state: "ready" }]) {
    const html = await render(Roster, props);
    assert.match(html, /No agents here yet/);
    assert.match(html, /<span>0<\/span>/);
    assert.doesNotMatch(html, /Loading agents|couldn’t be loaded|>Retry<\/button>/);
  }
});

test("refresh and failure retain known agents and counts while explaining stale updates", async () => {
  const rows = [{ id: "agent-a", name: "CrestBay", provider: "Claude Code", owner: "Owner",
    state: "Online", detail: "Ready for room work.", tone: "green", working: false, attention: false, moving: false }];
  for (const state of ["loading", "refreshing", "error"]) {
    const html = await render(Roster, { rows, state });
    assert.match(html, /CrestBay/);
    assert.match(html, /<span>1<\/span>/);
    assert.doesNotMatch(html, /No agents here yet|Loading agents…|Agents couldn’t be loaded/);
    assert.match(html, state === "error" ? /Showing the last loaded agents/ : /Updating agents…/);
  }
});

test("the desktop activity surface forwards roster readiness and hides its empty CTA until ready", async () => {
  const props = {
    recentActivity: [], participants: [], liveClearedCount: 0, presence: [], reasoningSessions: [], roomGitRoom: null,
    roomIdentifier: "focus_1", roomArtifacts: [], roomAgentWork: [], roomAgentWorkStatus: "idle", roomAgentWorkTruncated: false,
    activityHistoryRequest: 0, artifactTaskFilterId: null, tasks: [], messages: [], workers: [], supervisorEntries: [], agentProjections: [],
  };
  const loading = await render(Activity, { ...props, agentRosterState: "loading" });
  assert.match(loading, /Loading agents…/);
  assert.doesNotMatch(loading, /No agents here yet|>Refresh<\/button>/);
  const failed = await render(Activity, { ...props, agentRosterState: "error" });
  assert.match(failed, /Agents couldn’t be loaded/);
  assert.match(failed, />Retry<\/button>/);
  const ready = await render(Activity, { ...props, agentRosterState: "ready" });
  assert.match(ready, /No agents here yet/);
  assert.match(ready, />Refresh<\/button>/);
});

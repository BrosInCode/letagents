import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let AgentInspectorUsage: object;

before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  AgentInspectorUsage = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/agent-inspector/AgentInspectorUsage.vue")).default;
});

after(async () => {
  await vite?.close();
});

function usage(observedAt: string, state: "available" | "stale" = "available") {
  const resetsAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  return { providerContinuationId: "session", context: null, compaction: null,
    account: { state, windows: [{ id: "antigravity:gemini-5h", label: "5 hours", usedPercent: 12, resetsAt, observedAt }] } };
}

async function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(AgentInspectorUsage as never, { loading: false, stale: false, compacting: false, ...props }) }));
}

test("limits that are read on open say when they were read, not that an update is coming", async () => {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const onOpen = await render({ usage: usage(tenMinutesAgo), readOnOpen: true });
  assert.match(onOpen, /Limits as of [^<]+ · open the Overview again to update them/);
  assert.doesNotMatch(onOpen, /waiting for an update/);
  // A provider that keeps reading its limits still says an update is late.
  assert.match(await render({ usage: usage(tenMinutesAgo) }), /Last reported limits · waiting for an update/);
  // A read that failed keeps the last reading: only another open reads again.
  assert.match(await render({ usage: usage(tenMinutesAgo, "stale"), readOnOpen: true }), /Limits as of [^<]+ · open the Overview again/);
  // An Inspector that could not refresh at all still says so.
  assert.match(await render({ usage: usage(tenMinutesAgo), readOnOpen: true, stale: true }), /waiting for an update/);
  // A reading from another day names its day.
  const yesterday = new Date(Date.now() - 26 * 60 * 60_000);
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(yesterday);
  assert.match(await render({ usage: usage(yesterday.toISOString()), readOnOpen: true }), new RegExp(`Limits as of ${day}`));
  // A fresh reading shows no note.
  assert.doesNotMatch(await render({ usage: usage(new Date().toISOString()), readOnOpen: true }), /Limits as of|waiting for an update/);
});

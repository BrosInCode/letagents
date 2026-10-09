import assert from "node:assert/strict";
import test from "node:test";

import { ProviderUsageLimitNotices, type ProviderUsageLimitNoticeRequest } from "../provider-usage-limit-notices.js";
import type { DaemonManifestEntry } from "../types.js";

const entry = { id: "supervised_1", room_id: "focus_92", display_name: "CalmLake", provider: "claude-code" } as DaemonManifestEntry;
const grant = { entryId: "supervised_1", roomId: "focus_92", agentKey: "kd/calmlake", grantId: "grant_1",
  supervisorGrant: "secret", grantGeneration: 4, apiUrl: "https://letagents.chat" };

function notices(options: { entry?: DaemonManifestEntry | null; grant?: typeof grant | null; post?: (input: ProviderUsageLimitNoticeRequest) => Promise<boolean> } = {}) {
  const sent: Array<Omit<ProviderUsageLimitNoticeRequest, "signal">> = [];
  const warnings: string[] = [];
  const service = new ProviderUsageLimitNotices({
    loadEntry: async (id) => (options.entry === undefined ? entry : options.entry)?.id === id ? (options.entry === undefined ? entry : options.entry) : null,
    currentGrant: () => (options.grant === undefined ? grant : options.grant) as never,
    post: async (input) => {
      const { signal: _signal, ...rest } = input;
      sent.push(rest);
      return options.post ? options.post(input) : true;
    },
    warn: (message) => warnings.push(message),
  });
  return { service, sent, warnings };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("the room is told once per occurrence, with the agent's name, provider and reset", async () => {
  const { service, sent, warnings } = notices();
  service.report({ entryId: "supervised_1", phase: "turn", resetsAtMs: 1_760_018_400_000, occurrence: "inbox_7" });
  service.report({ entryId: "supervised_1", phase: "turn", resetsAtMs: 1_760_018_400_000, occurrence: "inbox_7" });
  service.report({ entryId: "supervised_1", phase: "start", resetsAtMs: null, occurrence: "start:unknown:1" });
  await settle();
  assert.deepEqual(sent, [
    { apiOrigin: "https://letagents.chat", grantId: "grant_1", supervisorGrant: "secret", grantGeneration: 4, roomId: "focus_92",
      agentKey: "kd/calmlake", displayName: "CalmLake", provider: "claude-code", phase: "turn", resetsAtMs: 1_760_018_400_000, occurrence: "inbox_7" },
    { apiOrigin: "https://letagents.chat", grantId: "grant_1", supervisorGrant: "secret", grantGeneration: 4, roomId: "focus_92",
      agentKey: "kd/calmlake", displayName: "CalmLake", provider: "claude-code", phase: "start", resetsAtMs: null, occurrence: "start:unknown:1" },
  ]);
  assert.deepEqual(warnings, []);
  await service.close();
});

test("nothing is posted for a local room, an unknown agent, or a grant for another room", async () => {
  for (const options of [{ entry: { ...entry, local_room_id: "local_1" } as DaemonManifestEntry }, { entry: null }, { grant: null },
    { grant: { ...grant, roomId: "elsewhere" } }]) {
    const { service, sent, warnings } = notices(options);
    service.report({ entryId: "supervised_1", phase: "turn", resetsAtMs: null, occurrence: "inbox_7" });
    await settle();
    assert.deepEqual(sent, [], JSON.stringify(options));
    assert.deepEqual(warnings, []);
    await service.close();
  }
});

test("a notice that fails is reported without the grant and can be tried again", async () => {
  let accept = false;
  const { service, sent, warnings } = notices({ post: async () => { if (!accept) throw new Error("offline"); return true; } });
  service.report({ entryId: "supervised_1", phase: "turn", resetsAtMs: null, occurrence: "inbox_7" });
  await settle();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.includes("secret"), false);
  accept = true;
  service.report({ entryId: "supervised_1", phase: "turn", resetsAtMs: null, occurrence: "inbox_7" });
  await settle();
  assert.equal(sent.length, 2);
  await service.close();
  service.report({ entryId: "supervised_1", phase: "turn", resetsAtMs: null, occurrence: "inbox_8" });
  await settle();
  assert.equal(sent.length, 2, "a closed service posts nothing");
});

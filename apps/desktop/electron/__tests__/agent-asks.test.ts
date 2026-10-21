import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH = join(mkdtempSync(join(tmpdir(), "agent-gifts-")), "gifts.json");
mock.module("electron", { defaultExport: { app: { isReady: () => false, setAsDefaultProtocolClient() {}, on() {} } }, namedExports: { app: { isReady: () => false, setAsDefaultProtocolClient() {}, on() {} } } });
const { AskGiveCoordinator, countUsage, giftEntryId, giftPermissionProfile, mainWindow } = await import("../asks/give-coordinator.js");
const { AskGiveError } = await import("../asks/api.js");
const { parseAskLink } = await import("../main/ask-links.js");

const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

test("links parse from the app scheme and the web, and nothing else", () => {
  assert.equal(parseAskLink(`letagents://ask/${TOKEN}`), TOKEN);
  assert.equal(parseAskLink(`https://letagents.chat/ask/${TOKEN}`), TOKEN);
  for (const url of [`http://letagents.chat/ask/${TOKEN}`, `letagents://room/${TOKEN}`, "letagents://ask/short", `https://x/ask/${TOKEN}/more`, "nope"]) {
    assert.equal(parseAskLink(url), null, url);
  }
});

test("a given agent is always a guest entry, so every rental safeguard applies", () => {
  assert.match(giftEntryId("ask_1"), /^supervised_rental_ask_[0-9a-f]{32}$/);
  assert.equal(giftEntryId("ask_1"), giftEntryId("ask_1"));
  assert.equal(giftPermissionProfile("cursor"), "sandboxed_write");
  assert.equal(giftPermissionProfile("claude-code"), "read_only");
  assert.equal(giftPermissionProfile("codex"), "read_only");
  assert.equal(giftPermissionProfile("open-model"), null);
  assert.equal(giftPermissionProfile("unknown"), null);
});

test("the gift counts against the longest limit and survives a window reset", () => {
  const usage = (windows: Array<[string, string, number]>) => ({ providerContinuationId: "c", context: null, compaction: null,
    account: { state: "available" as const, windows: windows.map(([id, label, usedPercent]) => ({ id, label, usedPercent, resetsAt: null, observedAt: "now" })) } });
  assert.equal(mainWindow(usage([["five_hour", "5 hours", 10], ["seven_day", "Weekly", 40]]), null)?.id, "seven_day");
  assert.equal(mainWindow(usage([["five_hour", "5 hours", 10]]), "seven_day")?.id, "five_hour");
  let gift = { windowId: null as string | null, lastUsedPercent: null as number | null, consumedPercent: 0 };
  gift = countUsage(gift, { id: "seven_day", usedPercent: 40 });
  gift = countUsage(gift, { id: "seven_day", usedPercent: 46 });
  assert.equal(gift.consumedPercent, 6);
  gift = countUsage(gift, { id: "seven_day", usedPercent: 3 });
  assert.equal(gift.consumedPercent, 9);
});

function fakes(overrides: { readyFails?: boolean; usedPercent?: number; preview?: Record<string, unknown>; release?: Record<string, unknown>; claimFails?: boolean } = {}) {
  const calls: string[] = [];
  const api = {
    claim: async () => { calls.push("claim"); if (overrides.claimFails) throw new Error("Someone is adding this agent right now."); return { id: "ask_1", asker: "Sam", state: "claimed" }; },
    release: async (_token: string, cantHelp: boolean) => { calls.push(`release:${cantHelp}`); return overrides.release ?? { ok: true }; },
    launchAuthority: async () => { calls.push("authority"); return { room_id: "room", grant: { supervisor_grant: "t", grant_id: "g", expires_at: "2099-01-01T00:00:00Z" } }; },
    joined: async () => { calls.push("joined"); return { id: "ask_1", state: "active" }; },
    preview: async () => ({ ask: { state: "active", is_giver: true, ...overrides.preview }, unavailable: null }), end: async () => ({}),
  };
  const entry = { id: giftEntryId("ask_1"), desiredState: "running", agentSessionId: "s", agentSessionBindingState: "active", readyReachedAt: "now", observedState: "running" };
  let stopped = false;
  const daemon = {
    ensureRunning: async () => ({ generation: 1 }),
    compareAndSetDesiredState: async () => true,
    list: async () => [overrides.readyFails || stopped ? { ...entry, observedState: stopped ? "stopped" : "failed" } : entry],
    getAgentInspectorDetail: async () => ({ usage: { account: { state: "available", windows: [{ id: "seven_day", label: "Weekly", usedPercent: overrides.usedPercent ?? 10 }] } } }),
    setDesiredState: async () => { stopped = true; calls.push("stop"); }, purgeAgent: async () => { calls.push("purge"); return { outcome: "purged" }; },
  };
  const grants = { createRentalPausedAndInstall: async () => { calls.push("install"); return { entry, agentKey: "john/helper" }; } };
  const coordinator = new AskGiveCoordinator(api as any, daemon as any, grants as any, () => "host",
    async () => "john/helper", async () => ({ canStart: true }) as any);
  return { coordinator, calls };
}

const give = { token: TOKEN, providerId: "cursor", model: null, modelLabel: "Cursor", amountPercent: 10 };

test("one tap gives the agent and records the gift", async () => {
  const { coordinator, calls } = fakes();
  const joined = await coordinator.give(give);
  coordinator.stopWatching();
  assert.equal(joined.state, "active");
  assert.deepEqual(calls, ["claim", "authority", "install", "joined"]);
});

test("any failure before joining stops the agent and gives the link back", async () => {
  const { coordinator, calls } = fakes({ readyFails: true });
  await assert.rejects(coordinator.give(give), (error: Error) => error instanceof AskGiveError && /request is still open/.test(error.message));
  assert.ok(calls.includes("purge"));
  assert.equal(calls.at(-1), "release:false");
});

test("the pre-check refuses to give more than is left", async () => {
  const { coordinator, calls } = fakes({ usedPercent: 94 });
  await assert.rejects(coordinator.give(give), /You have 6% of your weekly limit left/);
  assert.equal(calls.at(-1), "release:false");
});

test("providers without a verified folder lock can't be given", async () => {
  const { coordinator, calls } = fakes();
  await assert.rejects(coordinator.give({ ...give, providerId: "open-model" }), /can't be given safely yet/);
  assert.deepEqual(calls, []);
});

test("a guest Claude launches with no built-in tools and refuses to run with any", async () => {
  const { attestProviderSpawnPolicy } = await import("../main/agents/provider-spawn-configuration.js");
  const { GUEST_CLAUDE_LAUNCH_POLICY } = await import("../asks/give-coordinator.js");
  const { guestHasOnlyRoomTools } = await import("../main/agents/claude-code-provider-adapter.js");
  const request = (launchPolicy: unknown, permissionProfileId = "read_only") => ({ launchPolicy: { ...(launchPolicy as object) }, permissionProfileId,
    supervisorEntryId: giftEntryId("ask_1"), configurationRevision: 1, deliveryMode: "daemon_inbox" }) as any;
  assert.deepEqual(attestProviderSpawnPolicy("claude-code", request(GUEST_CLAUDE_LAUNCH_POLICY)).tools, []);
  assert.throws(() => attestProviderSpawnPolicy("claude-code", request({ ...GUEST_CLAUDE_LAUNCH_POLICY, tools: ["Read", "Glob", "Grep"] })), /tools/);
  assert.throws(() => attestProviderSpawnPolicy("claude-code", request({ permissionMode: "bypassPermissions" }, "full_access")), /guest agent runs Read-only/);
  assert.equal(guestHasOnlyRoomTools({ tools: ["mcp__letagents__read_messages", "mcp__letagents__ask_read_file"] } as any), true);
  assert.equal(guestHasOnlyRoomTools({ tools: ["mcp__letagents__read_messages", "Read"] } as any), false);
  assert.equal(guestHasOnlyRoomTools({} as any), false);
});

test("a guest Codex launch must be Read-only", async () => {
  const { attestProviderSpawnPolicy } = await import("../main/agents/provider-spawn-configuration.js");
  const request = (permissionProfileId: string, launchPolicy: unknown) => ({ launchPolicy, permissionProfileId,
    supervisorEntryId: giftEntryId("ask_1"), configurationRevision: 1, deliveryMode: "daemon_inbox" }) as any;
  assert.throws(() => attestProviderSpawnPolicy("codex", request("full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } })), /guest agent runs Read-only/);
  assert.equal(attestProviderSpawnPolicy("codex", request("read_only", { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } })).approvalPolicy, "never");
});

test("given agents have their own guest list; the rental marketplace stays Cursor-only", async () => {
  const profiles = await import("../main/agents/rental-permission-profiles.js");
  assert.deepEqual(profiles.listRentalSafePermissionProfiles("claude-code"), []);
  assert.deepEqual(profiles.listRentalSafePermissionProfiles("codex"), []);
  assert.deepEqual(profiles.listGuestSafePermissionProfiles("claude-code").map(p => p.id), ["read_only"]);
  assert.deepEqual(profiles.listGuestSafePermissionProfiles("codex").map(p => p.id), ["read_only"]);
  assert.deepEqual(profiles.listGuestSafePermissionProfiles("cursor").map(p => p.id), ["sandboxed_write"]);
  assert.throws(() => profiles.assertGuestSafePermissionProfile("codex", "full_access"), /can't be given/);
  assert.equal(profiles.isGivenAgentEntryId(giftEntryId("ask_1")), true);
  assert.equal(profiles.isGivenAgentEntryId("supervised_rental_0123456789abcdef"), false);
});

test("the watcher stops a gift whose ask was given to someone else", async () => {
  const { coordinator, calls } = fakes({ preview: { state: "active", is_giver: false } });
  await coordinator.give(give);
  coordinator.stopWatching();
  calls.length = 0;
  await coordinator.watchOnce();
  assert.ok(calls.includes("purge"), "the local agent is stopped and removed");
});

test("\"Can't right now\" reports when it could not tell the asker", async () => {
  const taken = fakes({ claimFails: true });
  await assert.rejects(taken.coordinator.cantHelp(TOKEN), /adding this agent right now/);
  assert.deepEqual(taken.calls, ["claim"]);
  const changed = fakes({ release: { ok: false } });
  await assert.rejects(changed.coordinator.cantHelp(TOKEN), /already changed/);
  const ok = fakes();
  await ok.coordinator.cantHelp(TOKEN);
  assert.deepEqual(ok.calls, ["claim", "release:true"]);
});

test("a link that arrives while a new window loads is held for its renderer", async () => {
  const inbox = await import("../main/ask-link-inbox.js");
  assert.equal(inbox.takePendingAskLink(), null);
  assert.equal(inbox.askLinkRendererReady(), true);
  inbox.askLinkRendererGone();
  assert.equal(inbox.askLinkRendererReady(), false);
  inbox.holdAskLink(TOKEN);
  assert.equal(inbox.takePendingAskLink(), TOKEN, "the new renderer takes it once it loads");
  assert.equal(inbox.takePendingAskLink(), null);
});

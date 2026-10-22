import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH = join(mkdtempSync(join(tmpdir(), "agent-gifts-")), "gifts.json");
const appEvents = new Map<string, (...args: any[]) => void>();
const appCalls: string[] = [];
const app = { isReady: () => false, isPackaged: false, setAsDefaultProtocolClient() { appCalls.push("scheme"); },
  on(name: string, handler: (...args: any[]) => void) { appEvents.set(name, handler); }, quit() { appCalls.push("quit"); },
  instanceLock: true, requestSingleInstanceLock() { return this.instanceLock; } };
const autoUpdater = { on() {} };
mock.module("electron", { defaultExport: { app, autoUpdater }, namedExports: { app, autoUpdater } });
const { AskGiveCoordinator, GIVE_UP_PURGE_TRIES, countUsage, giftEntryId, giftPermissionProfile, mainWindow, usedUpLimit } = await import("../asks/give-coordinator.js");
const { AskGiveError } = await import("../asks/api.js");
const { askLinkFromArgv, claimDesktopInstance, parseAskLink, registerAskLinks } = await import("../main/ask-links.js");
const { readFileSync } = await import("node:fs");

const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

test("links parse from the app scheme and the web, and nothing else", () => {
  assert.equal(parseAskLink(`letagents://ask/${TOKEN}`), TOKEN);
  assert.equal(parseAskLink(`https://letagents.chat/ask/${TOKEN}`), TOKEN);
  for (const url of [`http://letagents.chat/ask/${TOKEN}`, `letagents://room/${TOKEN}`, "letagents://ask/short", `https://x/ask/${TOKEN}/more`, "nope"]) {
    assert.equal(parseAskLink(url), null, url);
  }
});

test("on Windows and Linux the link is found among the launch arguments", () => {
  assert.equal(askLinkFromArgv(["C:\\LetAgents\\LetAgents.exe", "--flag", `letagents://ask/${TOKEN}`]), TOKEN);
  assert.equal(askLinkFromArgv(["/opt/LetAgents/letagents", "--no-sandbox"]), null);
});

test("a given agent is always a guest entry, so every rental safeguard applies", () => {
  assert.match(giftEntryId("ask_1", "try_1"), /^supervised_rental_ask_[0-9a-f]{32}$/);
  assert.equal(giftEntryId("ask_1", "try_1"), giftEntryId("ask_1", "try_1"));
  assert.notEqual(giftEntryId("ask_1", "try_1"), giftEntryId("ask_1", "try_2"), "each attempt is its own entry");
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

function fakes(overrides: { shortUsedPercent?: number; joinedState?: string; readyFails?: boolean; usedPercent?: number; preview?: Record<string, unknown>; release?: Record<string, unknown>; claimFails?: boolean; purgeAnswers?: Array<Record<string, unknown>> } = {}) {
  const calls: string[] = [];
  const requestIds: string[] = [];
  const api = {
    claim: async () => { calls.push("claim"); if (overrides.claimFails) throw new Error("Someone is adding this agent right now."); return { id: "ask_1", asker: "Sam", state: "claimed" }; },
    release: async (_token: string, cantHelp: boolean) => { calls.push(`release:${cantHelp}`); return overrides.release ?? { ok: true }; },
    launchAuthority: async () => { calls.push("authority"); return { room_id: "room", grant: { supervisor_grant: "t", grant_id: "g", expires_at: "2099-01-01T00:00:00Z" } }; },
    joined: async () => { calls.push("joined"); return { id: "ask_1", state: overrides.joinedState ?? "active" }; },
    models: async () => [{ providerId: "cursor", model: null, label: "Cursor" }, { providerId: "claude-code", model: "claude-opus-5-5", label: "Claude Opus 5.5" }],
    preview: async () => ({ ask: { state: "active", is_giver: true, ...overrides.preview }, unavailable: null }), end: async () => ({}),
  };
  const entry = { id: giftEntryId("ask_1", "try_1"), desiredState: "running", agentSessionId: "s", agentSessionBindingState: "active", readyReachedAt: "now", observedState: "running" };
  let stopped = false;
  const states: string[] = [];
  const daemon = {
    ensureRunning: async () => ({ generation: 1 }),
    compareAndSetDesiredState: async (_id: string, from: string, to: string) => { states.push(`${from}->${to}`); return true; },
    list: async () => [overrides.readyFails || stopped ? { ...entry, observedState: stopped ? "stopped" : "failed" } : entry],
    getAgentInspectorDetail: async () => ({ usage: { account: { state: "available", windows: [{ id: "seven_day", label: "Weekly", usedPercent: overrides.usedPercent ?? 10 },
      ...(overrides.shortUsedPercent === undefined ? [] : [{ id: "five_hour", label: "5 hours", usedPercent: overrides.shortUsedPercent }])] } } }),
    setDesiredState: async () => { stopped = true; calls.push("stop"); },
    purgeAgent: async () => { calls.push("purge"); return overrides.purgeAnswers?.shift() ?? { outcome: "purged" }; },
  };
  const grants = { createRentalPausedAndInstall: async (input: { creationRequestId: string }) => {
    calls.push("install"); requestIds.push(input.creationRequestId); return { entry, agentKey: "john/helper" };
  } };
  const coordinator = new AskGiveCoordinator(api as any, daemon as any, grants as any, () => "host",
    async () => "john/helper", async () => ({ canStart: true }) as any);
  return { coordinator, calls, states, requestIds };
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

test("every attempt for the same ask starts its own entry", async () => {
  const first = fakes({ readyFails: true });
  await assert.rejects(first.coordinator.give(give), /request is still open/);
  const second = fakes({ readyFails: true });
  await assert.rejects(second.coordinator.give({ ...give, providerId: "claude-code", model: "claude-opus-5-5" }), /request is still open/);
  const requestIds = [...first.requestIds, ...second.requestIds];
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1], "a failed try never blocks the next one on the daemon's creation id");
  for (const id of requestIds) assert.match(`supervised_${id}`, /^supervised_rental_ask_[0-9a-f]{32}$/);
});

const journal = () => JSON.parse(readFileSync(process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH!, "utf8"));
const refused = { outcome: "invalid", error: "Purge requires a fully stopped durable lifecycle." };
async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; warnings: unknown[][] }> {
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try { return { result: await run(), warnings }; } finally { console.warn = warn; }
}

test("a removal the daemon refuses keeps the gift until a later check removes the agent", async () => {
  // Refused in the failed attempt and again on the watch tick that attempt starts.
  const { coordinator, calls } = fakes({ readyFails: true, purgeAnswers: [refused, refused] });
  const { warnings } = await quietly(() => assert.rejects(coordinator.give(give), /request is still open/));
  assert.equal(calls.at(-1), "release:false", "the link is given back at once");
  assert.ok(warnings.some(args => String(args[2]).includes("fully stopped durable lifecycle")), "the daemon's reason is logged");
  await quietly(() => coordinator.watchOnce());
  coordinator.stopWatching();
  assert.equal(journal().gifts[TOKEN]?.purgePending, true, "the agent is remembered as still to remove");
  assert.equal(journal().gifts[TOKEN]?.purgeTries, 2);
  calls.length = 0;
  await coordinator.watchOnce();
  assert.deepEqual(calls, ["stop", "purge"], "the next check removes it without asking the server");
  assert.equal(journal().gifts[TOKEN], undefined, "and then forgets it");
});

test("a gift waiting only for its removal no longer counts against what is left to give", async () => {
  const failed = fakes({ usedPercent: 30, readyFails: true, purgeAnswers: [refused, refused] });
  await quietly(() => assert.rejects(failed.coordinator.give({ ...give, token: "d".repeat(32), amountPercent: 60 }), /request is still open/));
  await quietly(() => failed.coordinator.watchOnce());
  failed.coordinator.stopWatching();
  assert.equal(journal().gifts["d".repeat(32)]?.purgePending, true);
  const next = fakes({ usedPercent: 30 });
  await next.coordinator.give({ ...give, amountPercent: 60 });
  next.coordinator.stopWatching();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH!, JSON.stringify({ version: 1, gifts: {} }));
});

test("an attempt that died with the app is removed on the next check", async () => {
  const { writeFileSync } = await import("node:fs");
  const token = "e".repeat(32);
  writeFileSync(process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH!, JSON.stringify({ version: 1, gifts: { [token]: {
    token, askId: "ask_1", entryId: giftEntryId("ask_1", "died"), roomId: "room", providerId: "cursor", model: null, amountPercent: 10,
    windowId: null, lastUsedPercent: null, consumedPercent: 0, starting: true } } }));
  const { coordinator, calls } = fakes();
  await coordinator.watchOnce();
  assert.deepEqual(calls, ["stop", "purge"], "whatever the dead attempt left in the daemon goes, without a server call");
  assert.equal(journal().gifts[token], undefined);
});

test("after enough refusals the agent is left to the owner, so the other gifts' checks go on", async () => {
  const { writeFileSync } = await import("node:fs");
  const token = "f".repeat(32);
  writeFileSync(process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH!, JSON.stringify({ version: 1, gifts: { [token]: {
    token, askId: "ask_1", entryId: giftEntryId("ask_1", "stuck"), roomId: "room", providerId: "cursor", model: null, amountPercent: 10,
    windowId: null, lastUsedPercent: null, consumedPercent: 0, purgePending: true, purgeTries: GIVE_UP_PURGE_TRIES - 1 } } }));
  const { coordinator } = fakes({ purgeAnswers: [refused] });
  const { warnings } = await quietly(() => coordinator.watchOnce());
  assert.ok(warnings.some(args => String(args[2]).includes("to remove by hand")), "the owner is told where it is");
  assert.equal(journal().gifts[token], undefined, "and the journal stops retrying");
});

test("the pre-check counts what other gifts from the same app may still use", async () => {
  const first = fakes({ usedPercent: 30 });
  await first.coordinator.give({ ...give, token: "b".repeat(32), amountPercent: 50 });
  first.coordinator.stopWatching();
  const second = fakes({ usedPercent: 30 });
  await assert.rejects(second.coordinator.give({ ...give, amountPercent: 30 }), /20% of your weekly limit left after your other gifts/);
  await second.coordinator.give({ ...give, amountPercent: 20 });
  second.coordinator.stopWatching();
  await second.coordinator.pauseForQuit();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH!, JSON.stringify({ version: 1, gifts: {} }));
});

test("a used-up short limit refuses the gift, even with weekly room left", async () => {
  const { coordinator, calls } = fakes({ usedPercent: 20, shortUsedPercent: 100 });
  await assert.rejects(coordinator.give({ ...give, providerId: "claude-code", model: "claude-opus-5-5" }), /Your usage limit \(5 hours\) is used up/);
  assert.ok(calls.includes("purge"), "the started agent is stopped");
  assert.equal(calls.at(-1), "release:false", "and the link is given back");
});

test("only the limits that stop this model count as used up", () => {
  const usage = (windows: Array<[string, number]>) => ({ providerContinuationId: "c", context: null, compaction: null,
    account: { state: "available" as const, windows: windows.map(([id, usedPercent]) => ({ id, label: id, usedPercent, resetsAt: null, observedAt: "now" })) } });
  const full = (windows: Array<[string, number]>, providerId: string, model: string | null) => usedUpLimit(usage(windows), providerId, model)?.id ?? null;
  // Claude: another model's weekly limit and extra usage don't stop this one.
  assert.equal(full([["seven_day", 40], ["seven_day_opus", 100]], "claude-code", "claude-sonnet-5-5"), null);
  assert.equal(full([["seven_day", 40], ["seven_day_opus", 100]], "claude-code", "claude-opus-5-5"), "seven_day_opus");
  assert.equal(full([["five_hour", 20], ["overage", 100]], "claude-code", "claude-opus-5-5"), null);
  assert.equal(full([["five_hour", 100]], "claude-code", "claude-opus-5-5"), "five_hour");
  // Codex: only the main Codex bucket.
  assert.equal(full([["codex:primary", 10], ["extra:primary", 100]], "codex", "gpt-5"), null);
  assert.equal(full([["codex:secondary", 100]], "codex", "gpt-5"), "codex:secondary");
  // Cursor: included usage is used up only when no on-demand budget is left.
  assert.equal(full([["cursor-plan", 100], ["cursor-on-demand", 50]], "cursor", null), null);
  assert.equal(full([["cursor-plan", 100], ["cursor-on-demand", 100]], "cursor", null), "cursor-plan");
  assert.equal(full([["cursor-plan", 100]], "cursor", null), "cursor-plan");
  // The amount is counted against this model's main limit, never another model's.
  assert.equal(mainWindow(usage([["seven_day_opus", 90], ["five_hour", 10], ["seven_day", 30]]), null, "claude-code", "claude-sonnet-5-5")?.id, "seven_day");
});

test("only a model on the current list can be given", async () => {
  const { coordinator, calls } = fakes();
  await assert.rejects(coordinator.give({ ...give, providerId: "claude-code", model: "claude-opus-3" }), /isn't on the list anymore/);
  assert.deepEqual(calls, [], "nothing is claimed or started");
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
    supervisorEntryId: giftEntryId("ask_1", "try_1"), configurationRevision: 1, deliveryMode: "daemon_inbox" }) as any;
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
    supervisorEntryId: giftEntryId("ask_1", "try_1"), configurationRevision: 1, deliveryMode: "daemon_inbox" }) as any;
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
  assert.equal(profiles.isGivenAgentEntryId(giftEntryId("ask_1", "try_1")), true);
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

test("quitting pauses running gifts and the next start resumes them", async () => {
  const { coordinator, states } = fakes();
  await coordinator.give(give);
  coordinator.stopWatching();
  states.length = 0;
  await coordinator.pauseForQuit();
  assert.deepEqual(states, ["running->paused"]);
  assert.equal(journal().gifts[TOKEN].pausedForQuit, true);
  coordinator.startWatching();
  coordinator.stopWatching();
  for (let i = 0; i < 50 && journal().gifts[TOKEN].pausedForQuit; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(states.includes("paused->running"));
  assert.equal(journal().gifts[TOKEN].pausedForQuit, false);
});

test("a dev run leaves the letagents:// scheme alone, and quitting waits for gifts to pause", async () => {
  registerAskLinks();
  assert.ok(!appCalls.includes("scheme"), "only the packaged app takes the scheme");
  let held = false;
  appEvents.get("before-quit")!({ preventDefault: () => { held = true; } });
  assert.equal(held, true, "the first quit is held");
  for (let i = 0; i < 300 && !appCalls.includes("quit"); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(appCalls.includes("quit"), "then the app quits");
  let heldAgain = false;
  appEvents.get("before-quit")!({ preventDefault: () => { heldAgain = true; } });
  assert.equal(heldAgain, false, "the second quit goes straight through");
});

test("a substitute stays paused until the asker accepts it, then starts", async () => {
  const preview: Record<string, unknown> = { state: "on_hold", is_giver: true };
  const { coordinator, states } = fakes({ joinedState: "on_hold", preview });
  const joined = await coordinator.give(give);
  coordinator.stopWatching();
  assert.equal(joined.state, "on_hold");
  assert.deepEqual(states, ["paused->running", "running->paused"], "started to join, then paused");
  await coordinator.watchOnce();
  assert.deepEqual(states.slice(2), [], "still waiting: nothing changes");
  preview.state = "active";
  await coordinator.watchOnce();
  assert.deepEqual(states.slice(2), ["paused->running"], "accepted: the agent starts");
  await coordinator.watchOnce();
  assert.deepEqual(states.slice(3), [], "started once");
});

test("off macOS only the first instance runs; a later one hands its link over and starts nothing", async t => {
  const inbox = await import("../main/ask-link-inbox.js");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const argv = process.argv;
  t.after(() => { Object.defineProperty(process, "platform", platform); process.argv = argv; app.instanceLock = true; });
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  appEvents.delete("second-instance");
  inbox.takePendingAskLink();

  app.instanceLock = false;
  assert.equal(claimDesktopInstance(), false, "a second instance must exit");
  assert.equal(appEvents.has("second-instance"), false);

  app.instanceLock = true;
  process.argv = ["/opt/LetAgents/letagents", `letagents://ask/${TOKEN}`];
  assert.equal(claimDesktopInstance(), true);
  assert.equal(inbox.takePendingAskLink(), TOKEN, "a link the app was launched with is delivered");
  appEvents.get("second-instance")!({}, ["/opt/LetAgents/letagents", `letagents://ask/${"z".repeat(32)}`]);
  assert.equal(inbox.takePendingAskLink(), "z".repeat(32), "a later instance's link reaches this one");
});

test("the app claims its instance before starting anything", () => {
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const claim = main.indexOf("if (claimDesktopInstance()) startDesktopApp();\nelse app.exit(0);");
  assert.ok(claim > 0);
  assert.ok(main.indexOf("function startDesktopApp(): void {") > claim);
  for (const startup of ["prepareDesktopNotifications();", "registerAskLinks();", "registerDesktopIpcHandlers();", 'app.once("ready"']) {
    assert.ok(main.indexOf(startup) > main.indexOf("function startDesktopApp(): void {"), `${startup} runs only in the first instance`);
  }
});

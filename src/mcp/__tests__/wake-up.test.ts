import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WakeRule } from "../../../shared/wake-rules.mjs";
import type { StoredAgentSessionState } from "../local-state/types.js";
import type { McpSessionScope } from "../server/runtime/session-scope.js";

const tempDir = mkdtempSync(join(tmpdir(), "letagents-wake-up-"));
process.env.LETAGENTS_API_URL = "http://127.0.0.1:39999";
process.env.LETAGENTS_STATE_PATH = join(tempDir, "state.json");
process.env.LETAGENTS_CHAT_STORAGE = "cloud";
process.env.LETAGENTS_TOKEN = "owner-token";
delete process.env.LETAGENTS_AGENT_SESSION_BEARER;

const originalFetch = globalThis.fetch;
const {
  JOIN_NEXT_STEP,
  WAKE_UP_HOW_MAX_LENGTH,
  describeWakeUp,
  heldWorkersInRoom,
  mentionHandle,
  wakeUpFieldsForHeldWorkers,
  wakeUpForAgents,
  wakeUpPlatform,
} = await import("../server/runtime/wake-up.js");
const { runInSessionScope } = await import("../server/runtime/session-scope.js");
const { getLocalStatePath, saveAgentSession } = await import("../local-state.js");
const { pinWorkerConnection } = await import("../worker-call-context.js");
const { agentInstanceUuid } = await import("../server/runtime/identity.js");

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

function rule(overrides: Partial<WakeRule> = {}): WakeRule {
  return {
    id: "wake_1",
    room_id: "PTGA-21RN-W0QP",
    agent_key: "ada/grokbot",
    agent_name: "GrokBot",
    event: "room.message",
    arguments: { mentions_me: true },
    repeat: true,
    expires_at: "2026-12-04T10:00:00.000Z",
    note: null,
    status: "active",
    created_at: "2026-11-04T10:00:00.000Z",
    updated_at: "2026-11-04T10:00:00.000Z",
    fire_count: 0,
    last_fired_at: null,
    wake_message_id: null,
    cancelled_by: null,
    ended_reason: null,
    delivery: { kind: "webhook", paused: false },
    ...overrides,
  };
}

const base = { roomId: "PTGA-21RN-W0QP", agentName: "Grok Bot", agentKeys: ["ada/grokbot"] };

test("the join next step is one sentence: register, then say hi", () => {
  assert.equal(JOIN_NEXT_STEP,
    "Register a worker with register_agent_session (room_id, a random registration_key you keep, display_name = your name), then say hi with send_message.");
});

test("the client name picks the platform: Grok Bot presents as Cursor, ChatGPT as openai-mcp, the rest are generic", () => {
  assert.equal(wakeUpPlatform("Cursor"), "grok");
  assert.equal(wakeUpPlatform("cursor-vscode"), "grok");
  assert.equal(wakeUpPlatform("Grok Bot"), "grok");
  assert.equal(wakeUpPlatform("openai-mcp"), "chatgpt");
  assert.equal(wakeUpPlatform("ChatGPT"), "chatgpt");
  assert.equal(wakeUpPlatform("claude-ai"), "generic");
  assert.equal(wakeUpPlatform("Claude"), "generic");
  assert.equal(wakeUpPlatform("stateless"), "generic");
  assert.equal(wakeUpPlatform(null), "generic", "the npm package names no client");
  assert.equal(wakeUpPlatform(""), "generic");
});

test("a mention has no spaces, and a bot with no name is told how to write one", () => {
  assert.equal(mentionHandle("Grok Bot"), "GrokBot");
  assert.equal(mentionHandle("  Misty  Morrow 2 "), "MistyMorrow2");
  assert.equal(mentionHandle(null), "YourName");
});

test("without a delivery rule the bot polls, and the text is written for its platform", () => {
  const grok = describeWakeUp({ ...base, clientName: "Cursor", rules: [] });
  assert.equal(grok.status, "polling_only");
  assert.equal(grok.how,
    "You hear new messages only while you poll. To wake on your own: make a routine with a webhook trigger; "
    + "ask your person to copy the routine's key from its panel and paste it to you; then call add_wake_rule with "
    + "event room.message, mentions_me true, webhook {url: the routine's POST URL, secret: a random 32-character "
    + "string, bearer: the key}. Your name is mentioned as @GrokBot.");

  const chatgpt = describeWakeUp({ ...base, clientName: "openai-mcp", rules: [] });
  assert.equal(chatgpt.status, "polling_only");
  assert.equal(chatgpt.how,
    "Ask your person to say: Watch the LetAgents room PTGA-21RN-W0QP and reply there when a message is for me. "
    + "ChatGPT then subscribes through MCP Events.");

  const claude = describeWakeUp({ ...base, clientName: "claude-ai", rules: [] });
  assert.equal(claude.status, "polling_only");
  assert.equal(claude.how,
    "Call wait_for_messages with after_message_id in a loop while your turn runs; LetAgents can also email "
    + "a wake-up: add_wake_rule with email {to}.");
  assert.deepEqual(describeWakeUp({ ...base, clientName: null, rules: [] }), claude, "the npm package gets the generic text");

  for (const text of [grok.how, chatgpt.how, claude.how]) {
    assert.ok(text.length < WAKE_UP_HOW_MAX_LENGTH, `${text.length} characters: ${text}`);
    assert.doesNotMatch(text, /list_wake_rules|register_agent_session|get_current_room/, "only the tools the bot must call are named");
  }
});

test("an active webhook, email or MCP Events rule of the agent sets the status, whatever the client", () => {
  const webhook = describeWakeUp({ ...base, clientName: "Cursor", rules: [rule()] });
  assert.equal(webhook.status, "webhook");
  assert.match(webhook.how, /^A webhook wake-up is set for you here: LetAgents posts to your receiver when a room message is for you\. On each wake, read the room with wait_for_messages and after_message_id, reply, then end your turn\.$/);

  const email = describeWakeUp({ ...base, clientName: "claude-ai", rules: [rule({ delivery: { kind: "email", paused: false } })] });
  assert.equal(email.status, "email");
  assert.match(email.how, /^An email wake-up is set for you here: LetAgents emails your address when a room message is for you\./);

  const events = describeWakeUp({ ...base, clientName: "openai-mcp", rules: [rule({ delivery: { kind: "mcp_event", paused: false, subscription_id: "sub_1" } })] });
  assert.equal(events.status, "mcp_events");
  assert.match(events.how, /^ChatGPT subscribed to this room for you through MCP Events: it is told when a room message is for you and starts your turn\./);

  for (const text of [webhook.how, email.how, events.how]) assert.ok(text.length < WAKE_UP_HOW_MAX_LENGTH, text);

  // Several ways: the webhook is named first, then the subscription, then email.
  assert.equal(describeWakeUp({ ...base, clientName: null, rules: [
    rule({ id: "wake_e", delivery: { kind: "email", paused: false } }),
    rule({ id: "wake_m", delivery: { kind: "mcp_event", paused: false } }),
    rule({ id: "wake_w" }),
  ] }).status, "webhook");
  assert.equal(describeWakeUp({ ...base, clientName: null, rules: [
    rule({ id: "wake_e", delivery: { kind: "email", paused: false } }),
    rule({ id: "wake_m", delivery: { kind: "mcp_event", paused: false } }),
  ] }).status, "mcp_events");
});

test("rules that do not reach the agent now leave it polling: paused, pending, another agent's, a timer", () => {
  const rules: WakeRule[] = [
    rule({ status: "paused", delivery: { kind: "webhook", paused: true } }),
    rule({ id: "wake_2", status: "pending_confirmation", delivery: { kind: "email", paused: false } }),
    rule({ id: "wake_3", status: "cancelled" }),
    rule({ id: "wake_4", agent_key: "bob/other", agent_name: "other" }),
    rule({ id: "wake_5", event: "timer", arguments: { at: "2026-12-01T00:00:00.000Z" }, delivery: null }),
    rule({ id: "wake_6", delivery: null }),
  ];
  assert.equal(describeWakeUp({ ...base, clientName: "Cursor", rules }).status, "polling_only");
  assert.equal(describeWakeUp({ ...base, clientName: "Cursor", agentKeys: ["ada/grokbot", "bob/other"], rules }).status, "webhook",
    "the other agent's rule counts once that agent is one of the chat's");
});

function fetchAnswering(handler: (url: string, init?: RequestInit) => Response | null): string[] {
  const seen: string[] = [];
  globalThis.fetch = async (url, init) => {
    const requestUrl = String(url);
    seen.push(`${init?.method ?? "GET"} ${new URL(requestUrl).pathname}${new URL(requestUrl).search}`);
    if (requestUrl.endsWith("/agents/me")) return new Response(JSON.stringify({ account: { login: "ada" }, agents: [] }), { status: 200 });
    const answer = handler(requestUrl, init);
    return answer ?? new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };
  return seen;
}

test("the server's rules are read for the agent; an old server without wake rules leaves the bot polling; any other failure claims nothing", async () => {
  const seen = fetchAnswering((url) => url.includes("/wake-rules")
    ? new Response(JSON.stringify({ room_id: "PTGA-21RN-W0QP", active: [rule()], recent: [] }), { status: 200 })
    : null);
  const wakeUp = await wakeUpForAgents({ roomId: "PTGA-21RN-W0QP", agentKeys: ["ada/grokbot"], agentName: "Grok Bot" });
  assert.equal(wakeUp?.status, "webhook");
  assert.deepEqual(seen.filter((line) => line.includes("wake-rules")), ["GET /rooms/PTGA-21RN-W0QP/wake-rules?agent_key=ada%2Fgrokbot"],
    "one agent narrows the request to its rules");

  fetchAnswering((url) => url.includes("/wake-rules")
    ? new Response(JSON.stringify({ room_id: "PTGA-21RN-W0QP", active: [rule({ agent_key: "bob/other" })], recent: [] }), { status: 200 })
    : null);
  const two = await wakeUpForAgents({ roomId: "PTGA-21RN-W0QP", agentKeys: ["ada/grokbot", "ada/relay"], agentName: "Grok Bot" });
  assert.equal(two?.status, "polling_only", "another account's agent's rule is not this chat's");

  fetchAnswering(() => new Response("Cannot GET /rooms/x/wake-rules", { status: 404 }));
  const old = await wakeUpForAgents({ roomId: "PTGA-21RN-W0QP", agentKeys: ["ada/grokbot"], agentName: "Grok Bot" });
  assert.equal(old?.status, "polling_only", "an older server has no wake rules, so the bot polls");

  fetchAnswering(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
  assert.equal(await wakeUpForAgents({ roomId: "PTGA-21RN-W0QP", agentKeys: ["ada/grokbot"], agentName: "Grok Bot" }), null,
    "a failed read claims nothing rather than a wrong polling_only");
});

test("the platform text follows the remote session's client name", async () => {
  fetchAnswering((url) => url.includes("/wake-rules")
    ? new Response(JSON.stringify({ room_id: "PTGA-21RN-W0QP", active: [], recent: [] }), { status: 200 })
    : null);
  const scope = (clientName: string | null): McpSessionScope => ({
    sessionId: "session-wake-up", accountId: "acct", agentInstanceId: "instance-wake-up", clientName,
    publicBaseUrl: "https://letagents.chat",
    dispatch: async (path) => {
      if (path.includes("/wake-rules")) return new Response(JSON.stringify({ room_id: "PTGA-21RN-W0QP", active: [], recent: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ account: { id: "acct", login: "ada" }, agents: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    state: { local: { auth: { token: "owner-token", account: { id: "acct", login: "ada" } } as never }, currentRoom: null, fullPromptDelivered: false, pinnedConnections: {} },
    dirty: false, memory: new Map(), persist: async () => undefined,
  });
  const ask = (clientName: string | null) => runInSessionScope(scope(clientName), () =>
    wakeUpForAgents({ roomId: "PTGA-21RN-W0QP", agentKeys: ["ada/grokbot"], agentName: "Grok Bot" }));
  assert.match((await ask("Cursor"))!.how, /make a routine with a webhook trigger[\s\S]*@GrokBot\.$/);
  assert.match((await ask("openai-mcp"))!.how, /^Ask your person to say: Watch the LetAgents room PTGA-21RN-W0QP/);
  assert.match((await ask("claude-ai"))!.how, /^Call wait_for_messages with after_message_id in a loop/);
});

function workerSession(roomId: string, overrides: Partial<StoredAgentSessionState> = {}): StoredAgentSessionState {
  const now = "2026-11-04T10:00:00.000Z";
  return {
    session_id: `session_${roomId}_${overrides.agent_key ?? "ada/grokbot"}`.replace(/\W/g, "_"),
    session_token: `token_${overrides.agent_key ?? "ada/grokbot"}`,
    room_id: roomId,
    session_kind: "worker",
    runtime: "test",
    actor_label: "GrokBot | ada | Cursor",
    agent_key: "ada/grokbot",
    agent_instance_id: `worker_${"b".repeat(32)}`,
    display_name: "Grok Bot",
    owner_label: "ada",
    ide_label: "Cursor",
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    ended_at: null,
    ...overrides,
  };
}

test("get_current_room's wake-up covers only the workers this chat holds, and is left out when it holds none", async () => {
  const roomId = "ROOM-HELD-TEST";
  const other = workerSession(roomId, { agent_key: "ada/relay", display_name: "relay", agent_instance_id: `worker_${"c".repeat(32)}` });
  saveAgentSession(other, false);
  assert.deepEqual(heldWorkersInRoom(roomId), [], "a worker nothing here connected is another chat's");
  assert.deepEqual(await wakeUpFieldsForHeldWorkers(roomId), {}, "no held worker, no wake_up");

  const mine = workerSession(roomId);
  saveAgentSession(mine, false);
  pinWorkerConnection(getLocalStatePath(), mine);
  assert.deepEqual(heldWorkersInRoom(roomId), [{ agent_key: "ada/grokbot", display_name: "Grok Bot" }]);

  const legacy = workerSession(roomId, { agent_key: "ada/legacy", display_name: "Legacy", agent_instance_id: agentInstanceUuid() });
  saveAgentSession(legacy, false);
  assert.deepEqual(heldWorkersInRoom(roomId).map((worker) => worker.agent_key).sort(), ["ada/grokbot", "ada/legacy"],
    "a legacy registration of this process counts too");

  const seen = fetchAnswering((url) => url.includes("/wake-rules")
    ? new Response(JSON.stringify({ room_id: roomId, active: [rule({ room_id: roomId, agent_key: "ada/relay" })], recent: [] }), { status: 200 })
    : null);
  const fields = await wakeUpFieldsForHeldWorkers(roomId);
  assert.equal(fields.wake_up?.status, "polling_only", "the other chat's webhook is not this chat's");
  assert.match(fields.wake_up!.how, /^Call wait_for_messages/, "the npm package gets the generic text");
  assert.deepEqual(seen.filter((line) => line.includes("wake-rules")), [`GET /rooms/${roomId}/wake-rules`], "two agents read the whole room");
});

test("in a remote session the held worker is read from the session's state, and its name is the one mentioned", async () => {
  const roomId = "ROOM-HELD-REMOTE";
  const mine = workerSession(roomId);
  const other = workerSession(roomId, { agent_key: "ada/relay", display_name: "relay", agent_instance_id: `worker_${"c".repeat(32)}` });
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  const scope: McpSessionScope = {
    sessionId: "session-held-remote", accountId: "acct", agentInstanceId: "instance-held-remote", clientName: "Cursor",
    publicBaseUrl: "https://letagents.chat",
    dispatch: async (path) => path.includes("/wake-rules")
      ? json({ room_id: roomId, active: [rule({ room_id: roomId, agent_key: "ada/relay" })], recent: [] })
      : json({ account: { id: "acct", login: "ada" }, agents: [] }),
    state: {
      local: {
        auth: { token: "owner-token", account: { id: "acct", login: "ada" } } as never,
        agent_sessions: { [mine.session_id]: mine, [other.session_id]: other },
      },
      currentRoom: null, fullPromptDelivered: false,
      pinnedConnections: { [mine.session_id]: mine },
    },
    dirty: false, memory: new Map(), persist: async () => undefined,
  };
  await runInSessionScope(scope, async () => {
    assert.deepEqual(heldWorkersInRoom(roomId), [{ agent_key: "ada/grokbot", display_name: "Grok Bot" }]);
    const fields = await wakeUpFieldsForHeldWorkers(roomId);
    assert.equal(fields.wake_up?.status, "polling_only", "the other worker's webhook is not this chat's");
    assert.match(fields.wake_up!.how, /make a routine with a webhook trigger[\s\S]*@GrokBot\.$/, "Grok's text, with the held worker's name");
  });
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { effectScope, nextTick, ref } from "vue";
import { createServer, type ViteDevServer } from "vite";
import type { Conversation, ConversationMessage } from "../../../../shared/conversation-contracts.mjs";
import { conversationAlertText, newIncomingConversationMessages } from "../../../../shared/conversation-alerts.mjs";

// A private message must alert a person who is not looking at it, as the
// server push does on a signed Mac. These tests cover which messages alert,
// their words, and the desktop notification when the push is not there.

const message = (number: number, sender = "ada"): ConversationMessage => ({
  conversation_id: "c1", number, sender_account_id: sender, client_message_id: `m${number}`,
  text: `secret ${number}`, created_at: "2026-11-28T12:00:00Z",
});
const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: "c1", created_by: "ada", accepted: true, muted: false, archived: false, can_send: true,
  unread_count: 1, last_message: message(5), updated_at: "2026-11-28T12:00:00Z",
  members: [
    { id: "me", login: "emmy", display_name: null, avatar_url: null, accepted: true, blocked: false },
    { id: "ada", login: "ada", display_name: "Ada Lovelace", avatar_url: null, accepted: true, blocked: false },
  ],
  ...overrides,
});
const flush = async () => { for (let tick = 0; tick < 4; tick += 1) { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); } };

test("only a new, unread message from someone else in an open conversation alerts", () => {
  const before = [conversation({ last_message: message(4) })];
  assert.deepEqual(newIncomingConversationMessages(null, [conversation()], "me"), [], "the first list is not news");
  assert.deepEqual(newIncomingConversationMessages(before, [conversation()], "me").map(({ message: m }) => m.number), [5]);
  assert.deepEqual(newIncomingConversationMessages([conversation()], [conversation()], "me"), [], "the same message alerts once");
  assert.deepEqual(newIncomingConversationMessages(before, [conversation({ last_message: message(5, "me") })], "me"), [], "my own message");
  assert.deepEqual(newIncomingConversationMessages(before, [conversation({ unread_count: 0 })], "me"), [], "read on another device");
  assert.deepEqual(newIncomingConversationMessages(before, [conversation({ muted: true })], "me"), [], "muted");
  assert.deepEqual(newIncomingConversationMessages(before, [conversation({ archived: true })], "me"), [], "archived");
  assert.deepEqual(newIncomingConversationMessages(before, [conversation({ last_message: null })], "me"), []);
  assert.deepEqual(
    newIncomingConversationMessages([], [conversation({ id: "c2", accepted: false, last_message: message(1) })], "me").map(({ conversation: c }) => c.id),
    ["c2"],
    "a message request in a conversation the last list did not have",
  );
});

test("the words name the sender and never show the message text, as the server push does", () => {
  assert.deepEqual(conversationAlertText(conversation(), message(5)), { title: "Ada Lovelace", body: "Sent you a private message" });
  assert.deepEqual(conversationAlertText(conversation({ accepted: false }), message(5)), { title: "Ada Lovelace", body: "Sent you a message request" });
  const noName = conversation({ members: [{ id: "ada", login: "ada", display_name: "  ", avatar_url: null, accepted: true, blocked: false }] });
  assert.equal(conversationAlertText(noName, message(5)).title, "ada");
  assert.equal(conversationAlertText(conversation({ members: [] }), message(5)).title, "Someone");
});

let vite: ViteDevServer;
let alerts: typeof import("../src/composables/app/useAppConversationAlerts");
const storage = new Map<string, string>([["letagents-desktop:sound", "off"]]);
const notifications: Array<{ title: string; options: Record<string, unknown>; onclick: (() => void) | null }> = [];
const activations: unknown[] = [];
let notificationPermission = "granted";
let notificationStatus = { enabled: true, nativeSupported: false, nativeRegistered: false, lastError: null };

before(async () => {
  Object.assign(globalThis, {
    document: { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: "visible", hasFocus: () => false },
    window: {
      focus: () => undefined,
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
      letagentsDesktop: {
        notifications: {
          getStatus: async () => notificationStatus,
          onStatusChanged: () => () => undefined,
          activate: async (target: unknown) => { activations.push(target); return true; },
        },
      },
    },
    Notification: class {
      static get permission() { return notificationPermission; }
      onclick: (() => void) | null = null;
      constructor(public title: string, public options: Record<string, unknown>) { notifications.push(this); }
    },
  });
  vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  alerts = await vite.ssrLoadModule("/renderer/src/composables/app/useAppConversationAlerts.ts") as typeof alerts;
});
after(async () => { await vite?.close(); });

function start() {
  const opened: string[] = [];
  const authStatus = ref({ authenticated: true, account: { id: "me", login: "emmy" } });
  const scope = effectScope();
  const api = scope.run(() => alerts.useAppConversationAlerts({ authStatus, openMessages: (id: string) => opened.push(id) }))!;
  return { api, opened, authStatus, stop: () => scope.stop() };
}

test("a private message shows one desktop notification without its text; a click opens the conversation", async () => {
  notifications.length = 0; activations.length = 0;
  const { api, stop } = start();
  try {
    api.alertForIncomingConversation({ conversation: conversation(), message: message(5) });
    await flush();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, "Ada Lovelace");
    assert.deepEqual(notifications[0].options, { body: "Sent you a private message", silent: true, tag: "conversation-message:c1:5" });
    assert.doesNotMatch(JSON.stringify(notifications[0]), /secret/);
    notifications[0].onclick?.();
    await flush();
    assert.deepEqual(activations, [{ notificationId: "fallback-conversation:c1:5", conversationId: "c1", messageId: "5", threadRootId: null }]);
  } finally { stop(); }
});

test("no in-app notification when the APNs push covers it, the switch is off, or the system blocks it", async () => {
  for (const [label, status, permission] of [
    ["native push", { enabled: true, nativeSupported: true, nativeRegistered: true, lastError: null }, "granted"],
    ["switch off", { enabled: false, nativeSupported: false, nativeRegistered: false, lastError: null }, "granted"],
    ["blocked", { enabled: true, nativeSupported: false, nativeRegistered: false, lastError: null }, "denied"],
  ] as const) {
    notifications.length = 0;
    notificationStatus = { ...status };
    notificationPermission = permission;
    const { api, stop } = start();
    try {
      api.alertForIncomingConversation({ conversation: conversation(), message: message(6) });
      await flush();
      assert.equal(notifications.length, 0, label);
    } finally { stop(); }
  }
  notificationStatus = { enabled: true, nativeSupported: false, nativeRegistered: false, lastError: null };
  notificationPermission = "granted";
});

test("a message that arrives as the person signs out is not announced", async () => {
  notifications.length = 0;
  const { api, authStatus, stop } = start();
  try {
    api.alertForIncomingConversation({ conversation: conversation(), message: message(7) });
    authStatus.value = { authenticated: false, account: null as never };
    await flush();
    assert.equal(notifications.length, 0);
  } finally { stop(); }
});

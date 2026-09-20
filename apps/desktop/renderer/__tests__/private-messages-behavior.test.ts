import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";

const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL("../../../../shared/ui/PrivateMessages.vue", import.meta.url),
  "utf8",
);
const script = compileScript(parse(source).descriptor, {
  id: "private-chat-test",
  genDefaultAs: "PrivateMessages",
});
const code = ts.transpileModule(script.content, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const component = Function(
  "require",
  "exports",
  `${code}\nreturn PrivateMessages;`,
)(
  (id: string) =>
    id === "vue"
      ? { ...Vue, onMounted() {}, onBeforeUnmount() {} }
      : id.endsWith(".vue")
        ? {}
        : require(id),
  {},
);
const message = (number: number, clientId = `client-${number}`) => ({
  conversation_id: "chat",
  number,
  sender_account_id: number === 12 ? "me" : "other",
  client_message_id: clientId,
  text: `Message ${number}`,
  created_at: "2026-09-20T12:00:00Z",
});
const chat = {
  id: "chat",
  created_by: "me",
  members: [],
  accepted: true,
  muted: false,
  archived: false,
  can_send: true,
  unread_count: 1,
  last_message: message(12),
  updated_at: "2026-09-20T12:00:00Z",
};
function setup(api: Record<string, unknown>) {
  return component.setup(
    { api, accountId: "me", active: true, openConversationId: null },
    { expose() {}, emit() {} },
  );
}

test("an own-send acknowledgement cannot skip a concurrently arriving human message", async (t) => {
  const original = globalThis.document;
  Object.assign(globalThis, {
    document: { hasFocus: () => true, visibilityState: "visible" },
  });
  t.after(() => {
    Object.assign(globalThis, { document: original });
  });
  const cursors: number[] = [],
    reads: number[] = [];
  let acknowledged = message(12);
  const vm = setup({
    send: async (_id: string, _text: string, clientId: string) =>
      (acknowledged = message(12, clientId)),
    list: async () => ({ conversations: [chat], version: "2" }),
    messages: async (_id: string, cursor: { after: number }) => {
      cursors.push(cursor.after);
      return {
        messages: [message(11), acknowledged].filter(
          (item) => item.number > cursor.after,
        ),
        has_more: false,
      };
    },
    update: async (_id: string, changes: { last_read_number: number }) => {
      reads.push(changes.last_read_number);
    },
  });
  vm.chats.value = [chat];
  vm.selectedId.value = "chat";
  vm.messages.value = [message(10)];
  vm.draft.value = "My reply";
  await vm.send();
  assert.deepEqual(cursors, [10]);
  assert.deepEqual(
    vm.messages.value.map((item: { number: number }) => item.number),
    [10, 11, 12],
  );
  assert.equal(vm.outbox.value.chat, undefined);
  assert.deepEqual(reads, [12]);
});

test("an acknowledged message remains in the outbox when history refresh fails", async (t) => {
  const original = globalThis.document;
  Object.assign(globalThis, {
    document: { hasFocus: () => true, visibilityState: "visible" },
  });
  t.after(() => {
    Object.assign(globalThis, { document: original });
  });
  let acknowledged = message(12),
    failed = true,
    sendCount = 0;
  const vm = setup({
    send: async (_id: string, _text: string, clientId: string) => {
      sendCount++;
      return (acknowledged = message(12, clientId));
    },
    list: async () => {
      if (failed) throw new Error("Offline");
      return { conversations: [chat], version: "2" };
    },
    messages: async () => ({
      messages: [message(11), acknowledged],
      has_more: false,
    }),
    update: async () => {},
  });
  vm.chats.value = [chat];
  vm.selectedId.value = "chat";
  vm.messages.value = [message(10)];
  vm.draft.value = "My reply";
  await vm.send();
  assert.equal(vm.outbox.value.chat.text, "My reply");
  assert.deepEqual(
    vm.messages.value.map((item: { number: number }) => item.number),
    [10],
  );
  failed = false;
  await vm.refresh();
  assert.equal(vm.outbox.value.chat, undefined);
  assert.equal(sendCount, 1);
  assert.deepEqual(
    vm.messages.value.map((item: { number: number }) => item.number),
    [10, 11, 12],
  );
});

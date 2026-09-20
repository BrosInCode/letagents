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
let cleanup: (() => void)[] = [];
const component = Function(
  "require",
  "exports",
  `${code}\nreturn PrivateMessages;`,
)(
  (id: string) =>
    id === "vue"
      ? {
          ...Vue,
          onMounted() {},
          onBeforeUnmount(fn: () => void) {
            cleanup.push(fn);
          },
        }
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
  cleanup = [];
  const vm = component.setup(
    { api, accountId: "me", active: true, openConversationId: null },
    { expose() {}, emit() {} },
  );
  const callbacks = cleanup;
  vm.stop = () => callbacks.forEach((fn) => fn());
  return vm;
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

test("an unchanged-version poll retries history after its request fails following a send", async (t) => {
  const original = { document: globalThis.document, window: globalThis.window };
  Object.assign(globalThis, {
    document: {
      hasFocus: () => true,
      visibilityState: "visible",
      removeEventListener() {},
    },
    window: { removeEventListener() {} },
  });
  let acknowledged = message(12),
    historyCalls = 0,
    polls = 0;
  const vm = setup({
    send: async (_id: string, _text: string, clientId: string) =>
      (acknowledged = message(12, clientId)),
    list: async () => ({ conversations: [chat], version: "2" }),
    messages: async () => {
      if (++historyCalls === 1) throw new Error("Temporarily unavailable");
      return { messages: [message(11), acknowledged], has_more: false };
    },
    changes: async (after: string) => {
      assert.equal(after, "2");
      if (++polls === 1) return { version: "2" };
      return new Promise(() => {});
    },
    update: async () => {},
  });
  t.after(() => {
    vm.stop();
    Object.assign(globalThis, original);
  });
  vm.chats.value = [chat];
  vm.selectedId.value = "chat";
  vm.messages.value = [message(10)];
  vm.draft.value = "My reply";
  await vm.send();
  assert.equal(vm.historyNeedsRetry.value, true);
  assert.equal(vm.outbox.value.chat.acknowledgedNumber, 12);
  void vm.watchChanges();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyCalls, 2);
  assert.equal(vm.historyNeedsRetry.value, false);
  assert.equal(vm.outbox.value.chat, undefined);
  assert.deepEqual(
    vm.messages.value.map((item: { number: number }) => item.number),
    [10, 11, 12],
  );
});

test("returning after the acknowledged message falls before the latest page still clears its outbox", async (t) => {
  const original = globalThis.document;
  Object.assign(globalThis, {
    document: { hasFocus: () => true, visibilityState: "visible" },
  });
  t.after(() => Object.assign(globalThis, { document: original }));
  const vm = setup({
    messages: async () => ({ messages: [message(200)], has_more: true }),
    update: async () => {},
  });
  vm.chats.value = [chat];
  vm.selectedId.value = "chat";
  vm.outbox.value.chat = {
    text: "Already sent",
    id: "ack",
    failed: false,
    acknowledgedNumber: 12,
  };
  await vm.loadMessages(true);
  assert.equal(vm.outbox.value.chat, undefined);
  assert.deepEqual(
    vm.messages.value.map((item: { number: number }) => item.number),
    [200],
  );
});

test("late send responses cannot acknowledge or fail a newer outbox entry", async (t) => {
  const original = globalThis.document;
  Object.assign(globalThis, {
    document: { hasFocus: () => true, visibilityState: "visible" },
  });
  t.after(() => Object.assign(globalThis, { document: original }));
  for (const failed of [false, true]) {
    let finish!: () => void;
    const response = new Promise<ReturnType<typeof message>>(
      (resolve, reject) => {
        finish = () =>
          failed
            ? reject(new Error("Late failure"))
            : resolve(message(12, "old"));
      },
    );
    const vm = setup({
      send: async () => response,
      list: async () => ({ conversations: [chat], version: "2" }),
      messages: async () => ({
        messages: [message(11), message(12, "old")],
        has_more: false,
      }),
      update: async () => {},
    });
    vm.chats.value = [chat];
    vm.selectedId.value = "chat";
    vm.messages.value = [message(10)];
    vm.draft.value = "Old send";
    const sending = vm.send();
    await new Promise((resolve) => setImmediate(resolve));
    // A concurrent poll observed the first send and the user started a second.
    vm.outbox.value.chat = { text: "New send", id: "new", failed: false };
    finish();
    await sending;
    assert.deepEqual(
      { ...vm.outbox.value.chat },
      { text: "New send", id: "new", failed: false },
    );
  }
});

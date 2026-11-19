import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as Vue from "vue";
import { createRenderer, effectScope, nextTick, ref, ssrContextKey, type App } from "vue";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";
import type {
  DesktopPersistedOutgoingMessage,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopSaveOutgoingMessageInput,
  DesktopUpdateOutgoingMessageInput,
} from "../../electron/ipc-types";
import {
  clearDesktopMessageOutbox,
  desktopMessageOutbox,
  discardRefusedDesktopOutgoingMessage,
  hydrateDesktopMessageOutbox,
  INTERRUPTED_OUTBOX_DELIVERY_ERROR,
  reconcileDesktopMessageOutbox,
  retryDesktopOutgoingMessage,
} from "../src/domain/message-outbox";
import {
  clearDesktopMessageDrafts,
  setDesktopMessageDraftAccount,
  useDesktopMessageDraft,
} from "../src/domain/desktop-message-drafts";
import { useDesktopRoomMessages } from "../src/components/desktop/content/room-shell/useDesktopRoomMessages";
import {
  buildThreadIndicatorSummary,
  buildThreadSummaries,
} from "../src/components/desktop/content/room-chat/thread-utils";
import { useAppAccountScope, useAppAccountSwitch } from "../src/composables/app/useAppSession";

function roomInfo(overrides: Partial<DesktopRoomInfo> = {}): DesktopRoomInfo {
  return {
    identifier: "github.com/brosincode/letagents",
    displayName: "letagents",
    kind: "git",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    code: null,
    isLocal: false,
    ...overrides,
  } as DesktopRoomInfo;
}

function roomMessage(overrides: Partial<DesktopRoomMessage> = {}): DesktopRoomMessage {
  const id = overrides.id ?? "msg_1";
  return {
    id,
    clientMessageId: null,
    sender: "Alice",
    text: "Hello",
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: "2026-11-19T02:00:00.000Z",
    actorLabel: null,
    agentIdentity: null,
    threadRootId: id,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
    ...overrides,
  };
}

function withWindow<T>(value: unknown, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });
  return run().finally(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as Record<string, unknown>).window;
  });
}

class SimulatedDurableOutboxStore {
  private rows = new Map<string, DesktopPersistedOutgoingMessage & { bootId: number }>();
  private bootId = 1;
  public currentAccountScope = "account:acct_alice";
  public failNextSave: Error | null = null;
  public delayNextList: Promise<void> | null = null;

  simulateCrashAndRestart(): void {
    this.bootId += 1;
  }

  size(): number {
    return this.rows.size;
  }

  save = async (input: DesktopSaveOutgoingMessageInput): Promise<DesktopPersistedOutgoingMessage> => {
    if (this.failNextSave) {
      const error = this.failNextSave;
      this.failNextSave = null;
      throw error;
    }
    const storageMode = input.messageNamespace?.includes(":local:") ? "local" : "cloud";
    const row: DesktopPersistedOutgoingMessage & { bootId: number } = {
      ...input,
      accountScope: this.currentAccountScope,
      storageMode,
      status: "pending",
      error: null,
      sender: "You",
      updatedAt: input.timestamp,
      bootId: this.bootId,
    };
    this.rows.set(input.clientMessageId, row);
    const { bootId: _unused, ...persisted } = row;
    return persisted;
  };

  update = async (clientMessageId: string, patch: DesktopUpdateOutgoingMessageInput): Promise<void> => {
    const row = this.rows.get(clientMessageId);
    if (!row || row.accountScope !== this.currentAccountScope) return;
    if (patch.status) row.status = patch.status;
    if (patch.error !== undefined) row.error = patch.error;
    if (patch.gif !== undefined) row.gif = patch.gif;
    row.bootId = this.bootId;
  };

  remove = async (clientMessageId: string): Promise<void> => {
    const row = this.rows.get(clientMessageId);
    if (row && row.accountScope === this.currentAccountScope) {
      this.rows.delete(clientMessageId);
    }
  };

  list = async (): Promise<DesktopPersistedOutgoingMessage[]> => {
    const capturedScope = this.currentAccountScope;
    if (this.delayNextList) {
      const wait = this.delayNextList;
      this.delayNextList = null;
      await wait;
    }
    const items: DesktopPersistedOutgoingMessage[] = [];
    for (const row of this.rows.values()) {
      if (row.accountScope !== capturedScope) continue;
      if (row.status === "pending" && row.bootId !== this.bootId) {
        row.status = "uncertain";
        row.error = row.error || "Delivery could not be confirmed before the app closed.";
        row.bootId = this.bootId;
      }
      const { bootId: _unused, ...persisted } = row;
      items.push({ ...persisted, attachments: persisted.attachments.map((a) => ({ ...a })) });
    }
    return items;
  };
}

describe("desktop chat send crash recovery (renderer)", () => {
  it("waits for durable persistence before clearing composer, keeps composer usable while pending, and preserves draft on persistence failure", async () => {
    clearDesktopMessageOutbox();
    const store = new SimulatedDurableOutboxStore();
    const resolvers: Array<(value: { message: DesktopRoomMessage }) => void> = [];
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });

    await withWindow({
      letagentsDesktop: {
        room: {
          saveOutgoingMessage: async (input: DesktopSaveOutgoingMessageInput) => {
            await saveGate;
            return store.save(input);
          },
          updateOutgoingMessage: store.update,
          deleteOutgoingMessage: store.remove,
          listOutgoingMessages: store.list,
          sendMessage: () => new Promise((resolve) => { resolvers.push(resolve); }),
        },
      },
    }, async () => {
      const scope = effectScope();
      const messages = ref<DesktopRoomMessage[]>([]);
      const sentEvents: DesktopRoomMessage[] = [];
      const state = scope.run(() => useDesktopRoomMessages({
        room: ref(roomInfo()),
        messageNamespace: ref("github.com/brosincode/letagents:cloud:cloud"),
        messages,
        githubEventsVisible: ref(true),
        playRoomSound() {},
        onMessageSent(message) {
          sentEvents.push(message);
          messages.value = [...messages.value, message];
        },
      }))!;

      const completions: boolean[] = [];
      const firstSend = state.sendRoomMessage("First message", null, [], null, (ok) => completions.push(ok));
      // Before durable persist finishes, composer MUST NOT have cleared yet.
      assert.deepEqual(completions, []);
      assert.equal(desktopMessageOutbox.value.length, 0);

      releaseSave();
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Once durable persist finishes, composer clears immediately while delivery is still pending.
      assert.deepEqual(completions, [true]);
      assert.equal(state.sendingMessage.value, false, "composer stays usable while first delivery is pending");
      assert.equal(state.visibleMessages.value.length, 1);
      assert.equal(state.visibleMessages.value[0]!.outgoing?.status, "pending");

      // User can immediately compose and send a second message while the first is pending.
      const secondSend = state.sendRoomMessage("Second message", null, [], null, (ok) => completions.push(ok));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(completions, [true, true]);
      assert.equal(state.visibleMessages.value.length, 2);
      assert.equal(store.size(), 2);

      // Validation/scope persistence failure fails closed and does NOT clear the composer.
      store.failNextSave = new Error("This message belongs to a different room storage mode.");
      await state.sendRoomMessage("Should stay in composer", null, [], null, (ok) => completions.push(ok));
      assert.deepEqual(completions, [true, true, false]);
      assert.match(state.sendError.value ?? "", /different room storage mode/);
      assert.equal(state.visibleMessages.value.length, 2);

      // Local SQLite fault on a cloud room does NOT deadlock cloud sending and NEVER clears the composer before cloud confirmation.
      store.failNextSave = new Error("SQLITE_FULL: database or disk is full");
      const fallbackSend = state.sendRoomMessage("Cloud fallback message", null, [], null, (ok) => completions.push(ok));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(completions.length, 3, "composer must NOT clear before cloud fallback confirms");
      assert.equal(resolvers.length, 3, "cloud sendMessage runs directly when local SQLite fails");
      resolvers[2]!({ message: roomMessage({ id: "msg_12", text: "Cloud fallback message" }) });
      await fallbackSend;
      assert.deepEqual(completions, [true, true, false, true]);
      assert.equal(state.sendError.value, null);

      // Confirm both pending sends cleanly.
      const id1 = state.visibleMessages.value.find((m) => m.text === "First message")!.clientMessageId!;
      const id2 = state.visibleMessages.value.find((m) => m.text === "Second message")!.clientMessageId!;
      resolvers[0]!({ message: roomMessage({ id: "msg_10", text: "First message", clientMessageId: id1 }) });
      resolvers[1]!({ message: roomMessage({ id: "msg_11", text: "Second message", clientMessageId: id2 }) });
      await Promise.all([firstSend, secondSend]);
      await nextTick();

      assert.equal(sentEvents.length, 3);
      assert.equal(desktopMessageOutbox.value.length, 0);
      assert.equal(store.size(), 0);
      assert.deepEqual(state.visibleMessages.value.map((m) => m.id), ["msg_10", "msg_11", "msg_12"]);
      scope.stop();
    });
    clearDesktopMessageOutbox();
  });

  it("crash just before storage -> reopen via App auth startup watchers -> uncertain thread reply with attachment -> Retry reconciles to one row", async () => {
    clearDesktopMessageOutbox();
    const store = new SimulatedDurableOutboxStore();
    const room = roomInfo();
    const namespace = `${room.identifier}:cloud:cloud`;
    const root = roomMessage({ id: "msg_1", text: "Thread root" });
    const storedOnServer: DesktopRoomMessage[] = [root];
    let crashBeforeStorage = true;

    await withWindow({
      letagentsDesktop: {
        room: {
          saveOutgoingMessage: store.save,
          updateOutgoingMessage: store.update,
          deleteOutgoingMessage: store.remove,
          listOutgoingMessages: store.list,
          sendMessage: async (
            _roomId: string,
            text: string,
            replyTo: string | null,
            attachments: Array<{ upload_id: string }>,
            threadRootId: string | null,
            clientMessageId: string,
          ) => {
            if (crashBeforeStorage) {
              return new Promise(() => undefined); // process killed before storage
            }
            const existing = storedOnServer.find((m) => m.clientMessageId === clientMessageId);
            if (existing) return { message: existing };
            const created = roomMessage({
              id: `msg_${storedOnServer.length + 1}`,
              clientMessageId,
              text,
              threadRootId: threadRootId || `msg_${storedOnServer.length + 1}`,
              threadReplyToId: replyTo,
              attachments: attachments.map((a, idx) => ({
                id: `att_${idx + 1}`,
                fileName: "crash-proof.png",
                mimeType: "image/png",
                sizeBytes: 2048,
                href: `letagents-attachment://download/${a.upload_id}`,
              })),
            });
            storedOnServer.push(created);
            return { message: created };
          },
        },
      },
    }, async () => {
      // Session 1: send a thread reply with an attachment; composer clears, then crash before storage.
      const session1 = effectScope();
      const s1Messages = ref<DesktopRoomMessage[]>([root]);
      const s1State = session1.run(() => useDesktopRoomMessages({
        room: ref(room),
        messageNamespace: ref(namespace),
        messages: s1Messages,
        githubEventsVisible: ref(true),
        playRoomSound() {},
        onMessageSent() {},
      }))!;

      let composerCleared = false;
      void s1State.sendRoomMessage(
        "Important thread reply",
        root.id,
        [{ upload_id: "upl_thread_0001", fileName: "crash-proof.png", mimeType: "image/png", sizeBytes: 2048 }],
        root.id,
        (sent) => { composerCleared = sent; },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(composerCleared, true);
      assert.equal(store.size(), 1);
      assert.equal(storedOnServer.length, 1, "nothing stored before crash");
      session1.stop();

      // App crashes and reopens cleanly.
      clearDesktopMessageOutbox();
      store.simulateCrashAndRestart();
      crashBeforeStorage = false;

      // Exercise the real startup watcher sequence: useAppAccountScope BEFORE useAppAccountSwitch,
      // transitioning authStatus from null -> authenticated!
      const session2 = effectScope();
      const authStatus = ref<{ authenticated: boolean; account: { id: string; login: string } | null } | null>(null);
      const inboxRentals = ref<unknown[]>([]);
      const inboxRentalError = ref("");
      const inboxSection = ref("needs-you");
      const rentalRequestCount = ref(0);
      const authSessionLocked = ref(false);
      session2.run(() => {
        useAppAccountScope({ authStatus });
        useAppAccountSwitch({
          authSessionLocked,
          authStatus,
          inboxRentalError,
          inboxRentals,
          inboxSection,
          refreshNeedsYou: () => undefined,
          reloadInboxRooms: () => undefined,
          rentalRequestCount,
          resetNeedsYou: () => undefined,
        });
      });

      authStatus.value = { authenticated: true, account: { id: "acct_alice", login: "alice" } };
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Verify restored entry was NOT cancelled by useAppAccountSwitch!
      assert.equal(desktopMessageOutbox.value.length, 1);
      const restoredEntry = desktopMessageOutbox.value[0]!;
      assert.equal(restoredEntry.message.outgoing?.status, "uncertain");
      assert.equal(restoredEntry.threadRootId, root.id);
      assert.equal(restoredEntry.attachments[0]!.fileName, "crash-proof.png");

      const s2Messages = ref<DesktopRoomMessage[]>([...storedOnServer]);
      const s2State = session2.run(() => useDesktopRoomMessages({
        room: ref(room),
        messageNamespace: ref(namespace),
        messages: s2Messages,
        githubEventsVisible: ref(true),
        playRoomSound() {},
        onMessageSent(message) {
          s2Messages.value = [...s2Messages.value, message];
        },
      }))!;

      // Thread indicator on root shows the unconfirmed reply before even opening the thread.
      const summaries = buildThreadSummaries(s2State.visibleMessages.value);
      const indicator = buildThreadIndicatorSummary(root, summaries.get(root.id) ?? null);
      assert.equal(indicator.count, 1);
      assert.equal(indicator.hasUncertainOutgoing, true);

      // User activates Retry -> reconciles to 1 stored message, 1 row, 1 attachment.
      await retryDesktopOutgoingMessage(restoredEntry.clientMessageId);
      await nextTick();

      assert.equal(storedOnServer.length, 2);
      assert.equal(desktopMessageOutbox.value.length, 0);
      assert.equal(store.size(), 0);
      const threadReplies = s2State.visibleMessages.value.filter((m) => m.threadRootId === root.id && m.id !== root.id);
      assert.equal(threadReplies.length, 1);
      assert.equal(threadReplies[0]!.id, "msg_2");
      assert.equal(threadReplies[0]!.outgoing, undefined);
      assert.equal(threadReplies[0]!.attachments.length, 1);
      session2.stop();
    });
    clearDesktopMessageOutbox();
  });

  it("crash just after storage before ack reconciles when history loads BEFORE or AFTER hydration and via thread fetch without duplicates", async () => {
    for (const historyBeforeHydrate of [true, false]) {
      clearDesktopMessageOutbox();
      const store = new SimulatedDurableOutboxStore();
      const room = roomInfo({ identifier: "local:room-after-ack", isLocal: true });
      const namespace = `${room.identifier}:local:${room.identifier}`;
      const clientMessageId = "desktop-send:77777777-7777-4777-8777-777777777777";
      await store.save({
        clientMessageId,
        roomIdentifier: room.identifier,
        messageNamespace: namespace,
        text: "Committed before crash",
        replyTo: "msg_1",
        threadRootId: "msg_1",
        attachments: [{ upload_id: "local:att-1", fileName: "shot.png", mimeType: "image/png", sizeBytes: 512 }],
        replyPreview: null,
        timestamp: "2026-11-19T02:10:00.000Z",
      });
      store.simulateCrashAndRestart();

      const canonical = roomMessage({
        id: "msg_2",
        clientMessageId,
        text: "Committed before crash",
        threadRootId: "msg_1",
        threadReplyToId: "msg_1",
        attachments: [{ id: "local:att-1", fileName: "shot.png", mimeType: "image/png", sizeBytes: 512, href: "letagents-attachment://local/x" }],
      });

      await withWindow({
        letagentsDesktop: {
          room: {
            saveOutgoingMessage: store.save,
            updateOutgoingMessage: store.update,
            deleteOutgoingMessage: store.remove,
            listOutgoingMessages: store.list,
            sendMessage: async () => ({ message: canonical }),
          },
        },
      }, async () => {
        const scope = effectScope();
        const messages = ref<DesktopRoomMessage[]>(historyBeforeHydrate ? [roomMessage({ id: "msg_1" }), canonical] : [roomMessage({ id: "msg_1" })]);
        const state = scope.run(() => useDesktopRoomMessages({
          room: ref(room),
          messageNamespace: ref(namespace),
          messages,
          githubEventsVisible: ref(true),
          playRoomSound() {},
          onMessageSent() {},
        }))!;

        await hydrateDesktopMessageOutbox();
        if (!historyBeforeHydrate) {
          assert.equal(desktopMessageOutbox.value.length, 1);
          // Reconcile via thread load (even if top-level snapshot didn't carry the reply)
          reconcileDesktopMessageOutbox(room.identifier, [canonical], namespace);
        }
        await nextTick();
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(desktopMessageOutbox.value.length, 0);
        assert.equal(store.size(), 0);
        if (historyBeforeHydrate) {
          const replies = state.visibleMessages.value.filter((m) => m.threadRootId === "msg_1" && m.id !== "msg_1");
          assert.equal(replies.length, 1);
          assert.equal(replies[0]!.attachments.length, 1);
        }
        scope.stop();
      });
    }
    clearDesktopMessageOutbox();
  });

  it("account switch fences in-flight hydration and never leaks another account's outbox", async () => {
    clearDesktopMessageOutbox();
    const store = new SimulatedDurableOutboxStore();
    store.currentAccountScope = "account:acct_alice";
    await store.save({
      clientMessageId: "desktop-send:88888888-8888-4888-8888-888888888888",
      roomIdentifier: "room-a",
      messageNamespace: "room-a:cloud:cloud",
      text: "Alice secret",
      replyTo: null,
      threadRootId: null,
      attachments: [],
      replyPreview: null,
      timestamp: "2026-11-19T02:11:00.000Z",
    });
    store.simulateCrashAndRestart();

    let releaseAliceList!: () => void;
    store.delayNextList = new Promise<void>((resolve) => { releaseAliceList = resolve; });

    await withWindow({
      letagentsDesktop: {
        room: {
          listOutgoingMessages: store.list,
        },
      },
    }, async () => {
      const aliceHydration = hydrateDesktopMessageOutbox();
      // Account switches to Bob before Alice's listOutgoingMessages resolves!
      store.currentAccountScope = "account:acct_bob";
      clearDesktopMessageOutbox();
      const bobHydration = hydrateDesktopMessageOutbox();
      releaseAliceList();
      await Promise.all([aliceHydration, bobHydration]);
      assert.equal(desktopMessageOutbox.value.length, 0, "stale Alice hydration must not land in Bob's outbox");
    });
    clearDesktopMessageOutbox();
  });

  it("renderer-only restart while Electron main process stays alive (same boot_id) recovers saved pending send as uncertain and retryable", async () => {
    clearDesktopMessageOutbox();
    const store = new SimulatedDurableOutboxStore();
    const roomId = "github.com/brosincode/letagents";
    const namespace = `${roomId}:cloud:cloud`;
    const root = roomMessage({ id: "msg_root_reload", text: "Thread root for renderer restart" });
    const clientMessageId = "desktop-send:abababab-abab-4aba-8aba-abababababab";

    // Persist directly (same boot_id — do NOT call simulateCrashAndRestart!).
    const saved = await store.save({
      clientMessageId,
      roomIdentifier: roomId,
      messageNamespace: namespace,
      text: "Saved before renderer died prior to dispatch",
      replyTo: root.id,
      threadRootId: root.id,
      attachments: [{
        upload_id: "upl_reload_1",
        fileName: "renderer-crash-note.txt",
        mimeType: "text/plain",
        sizeBytes: 128,
      }],
      replyPreview: {
        id: root.id,
        sender: root.sender,
        text: root.text,
        source: root.source ?? null,
        timestamp: root.timestamp,
        agentIdentity: root.agentIdentity ?? null,
      },
      timestamp: "2026-11-19T02:20:00.000Z",
    });
    assert.equal(saved.status, "pending");

    // Lose the renderer before dispatch while Electron's main process stays alive.
    clearDesktopMessageOutbox();
    const rawStillPending = await store.list();
    assert.equal(rawStillPending.length, 1);
    assert.equal(rawStillPending[0]?.status, "pending", "main process still has the current boot_id");

    const dispatched: Array<{ clientMessageId?: string; threadRootId?: string | null; attachments?: unknown }> = [];
    await withWindow({
      letagentsDesktop: {
        room: {
          saveOutgoingMessage: store.save,
          updateOutgoingMessage: store.update,
          deleteOutgoingMessage: store.remove,
          listOutgoingMessages: store.list,
          sendMessage: async (
            _roomIdentifier: string,
            text: string,
            replyTo: string | null,
            attachments: Array<{ upload_id: string }>,
            threadRootId: string | null,
            cid: string,
          ) => {
            dispatched.push({ clientMessageId: cid, threadRootId, attachments });
            return {
              message: roomMessage({
                id: "msg_reload_confirmed",
                clientMessageId: cid,
                sender: "You",
                text,
                threadRootId,
                threadReplyToId: replyTo,
                attachments: attachments.map((a, idx) => ({
                  id: `att_reload_${idx}`,
                  fileName: "renderer-crash-note.txt",
                  mimeType: "text/plain",
                  sizeBytes: 128,
                  href: `https://letagents.chat/att/${a.upload_id}`,
                })),
              }),
            };
          },
          getMessagesBefore: async () => ({ messages: [], hasOlder: false }),
        },
      },
    }, async () => {
      const messages = ref<DesktopRoomMessage[]>([root]);
      const scope = effectScope();
      try {
        const shell = scope.run(() => useDesktopRoomMessages({
          room: ref(roomInfo({ identifier: roomId })),
          messageNamespace: ref(namespace),
          messages,
          githubEventsVisible: ref(true),
          playRoomSound: () => undefined,
          onMessageSent(message) {
            messages.value = [...messages.value, message];
          },
        }))!;

        await hydrateDesktopMessageOutbox();
        await nextTick();

        assert.equal(desktopMessageOutbox.value.length, 1);
        const recovered = desktopMessageOutbox.value[0]!;
        assert.equal(recovered.inFlight, false);
        assert.equal(recovered.message.outgoing?.status, "uncertain", "orphaned pending row must become uncertain and retryable");
        assert.equal(recovered.message.outgoing?.error, INTERRUPTED_OUTBOX_DELIVERY_ERROR);
        assert.equal(recovered.attachments[0]?.fileName, "renderer-crash-note.txt");

        // Persisted store row is also updated to uncertain.
        await Promise.resolve();
        const updatedPersisted = await store.list();
        assert.equal(updatedPersisted[0]?.status, "uncertain");

        // Retry safely delivers once and reconciles cleanly.
        await retryDesktopOutgoingMessage(clientMessageId);
        await nextTick();

        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0]?.clientMessageId, clientMessageId);
        assert.equal(dispatched[0]?.threadRootId, root.id);
        assert.deepEqual(dispatched[0]?.attachments, [{ upload_id: "upl_reload_1" }]);
        assert.equal(desktopMessageOutbox.value.length, 0);
        assert.equal((await store.list()).length, 0);

        const uiRows = shell.visibleMessages.value.filter((m) => m.clientMessageId === clientMessageId);
        assert.equal(uiRows.length, 1);
        assert.equal(uiRows[0]?.outgoing, undefined);
        assert.equal(uiRows[0]?.attachments.length, 1);
      } finally {
        scope.stop();
      }
    });
    clearDesktopMessageOutbox();
  });

  it("keeps genuinely active sends pending during concurrent hydration while promoting orphaned pending rows to uncertain", async () => {
    clearDesktopMessageOutbox();
    const store = new SimulatedDurableOutboxStore();
    const roomId = "github.com/brosincode/letagents";
    const namespace = `${roomId}:cloud:cloud`;

    // Seed an orphaned pending row from an earlier dead renderer (same boot_id).
    const orphanedId = "desktop-send:cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
    await store.save({
      clientMessageId: orphanedId,
      roomIdentifier: roomId,
      messageNamespace: namespace,
      text: "Orphaned send from dead renderer",
      replyTo: null,
      threadRootId: null,
      attachments: [],
      replyPreview: null,
      timestamp: "2026-11-19T02:21:00.000Z",
    });

    let releaseSave!: () => void;
    const holdSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    let releaseSend!: (msg: DesktopRoomMessage) => void;
    const holdSend = new Promise<DesktopRoomMessage>((resolve) => { releaseSend = resolve; });
    let activeClientId = "";

    await withWindow({
      letagentsDesktop: {
        room: {
          saveOutgoingMessage: async (input: DesktopSaveOutgoingMessageInput) => {
            activeClientId = input.clientMessageId;
            const saved = await store.save(input);
            await holdSave;
            return saved;
          },
          updateOutgoingMessage: store.update,
          deleteOutgoingMessage: store.remove,
          listOutgoingMessages: store.list,
          sendMessage: async () => ({ message: await holdSend }),
          getMessagesBefore: async () => ({ messages: [], hasOlder: false }),
        },
      },
    }, async () => {
      const messages = ref<DesktopRoomMessage[]>([]);
      const scope = effectScope();
      try {
        const shell = scope.run(() => useDesktopRoomMessages({
          room: ref(roomInfo({ identifier: roomId })),
          messageNamespace: ref(namespace),
          messages,
          githubEventsVisible: ref(true),
          playRoomSound: () => undefined,
          onMessageSent(message) {
            messages.value = [...messages.value, message];
          },
        }))!;

        let composerCleared = false;
        const sendPromise = shell.sendRoomMessage("Live in-flight message", null, [], null, (sent) => {
          composerCleared = sent;
        });

        // Wait until saveOutgoingMessage has written the live row to SQLite (still paused before enqueue).
        await Promise.resolve();
        await Promise.resolve();
        assert.ok(activeClientId, "active save should have started");

        // Hydrate while the live send is still in saveOutgoingMessage:
        // orphaned row must become uncertain, live row must be skipped (not prematurely marked uncertain).
        await hydrateDesktopMessageOutbox();
        const orphanedAfterFirstHydrate = desktopMessageOutbox.value.find((e) => e.clientMessageId === orphanedId);
        assert.equal(orphanedAfterFirstHydrate?.message.outgoing?.status, "uncertain");
        assert.equal(
          desktopMessageOutbox.value.find((e) => e.clientMessageId === activeClientId),
          undefined,
          "live save in progress must not be hydrated as uncertain",
        );

        // Release save -> composer clears and sendMessage enters inFlight=true.
        releaseSave();
        await Promise.resolve();
        await Promise.resolve();
        await nextTick();
        assert.equal(composerCleared, true);

        const activeEntry = desktopMessageOutbox.value.find((e) => e.clientMessageId === activeClientId);
        assert.ok(activeEntry);
        assert.equal(activeEntry.inFlight, true);
        assert.equal(activeEntry.message.outgoing?.status, "pending");

        // Hydrate again while sendMessage is genuinely in-flight: must stay pending!
        await hydrateDesktopMessageOutbox();
        const activeAfterSecondHydrate = desktopMessageOutbox.value.find((e) => e.clientMessageId === activeClientId);
        assert.equal(activeAfterSecondHydrate?.inFlight, true);
        assert.equal(activeAfterSecondHydrate?.message.outgoing?.status, "pending");

        // Finish live send cleanly.
        releaseSend(roomMessage({
          id: "msg_live_1",
          clientMessageId: activeClientId,
          text: "Live in-flight message",
          sender: "You",
        }));
        await sendPromise;
        await nextTick();
        assert.equal(
          desktopMessageOutbox.value.find((e) => e.clientMessageId === activeClientId),
          undefined,
          "confirmed live send is removed from outbox",
        );
        assert.equal(
          desktopMessageOutbox.value.find((e) => e.clientMessageId === orphanedId)?.message.outgoing?.status,
          "uncertain",
          "orphaned send remains uncertain until retried",
        );
      } finally {
        scope.stop();
      }
    });
    clearDesktopMessageOutbox();
  });

  it("marks definite pre-commit refusals as refused with Discard restoring text to original room/thread draft, while keeping ambiguous failures Retry-only", async () => {
    clearDesktopMessageOutbox();
    clearDesktopMessageDrafts();
    setDesktopMessageDraftAccount("acct_1");
    const store = new SimulatedDurableOutboxStore();
    const roomId = "github.com/brosincode/letagents";
    const namespace = `${roomId}:cloud:cloud`;
    const root = roomMessage({ id: "msg_root_refusal", text: "Root" });
    const deletedCalls: Array<{ id: string; options?: { discardAttachments?: boolean } }> = [];
    let failAmbiguousWith403 = false;

    await withWindow({
      letagentsDesktop: {
        room: {
          saveOutgoingMessage: store.save,
          updateOutgoingMessage: store.update,
          deleteOutgoingMessage: async (id: string, options?: { discardAttachments?: boolean }) => {
            deletedCalls.push({ id, options });
            await store.remove(id);
          },
          listOutgoingMessages: store.list,
          sendMessage: async (_r: string, text: string) => {
            if (text.includes("Forbidden") || failAmbiguousWith403) {
              throw new Error("Error invoking remote method 'desktop:room:send-message': Error: precommit_refusal: You were removed from this room.");
            }
            throw new Error("Network disconnected mid-request");
          },
          getMessagesBefore: async () => ({ messages: [], hasOlder: false }),
        },
      },
    }, async () => {
      const messages = ref<DesktopRoomMessage[]>([root]);
      const scope = effectScope();
      try {
        const shell = scope.run(() => useDesktopRoomMessages({
          room: ref(roomInfo({ identifier: roomId })),
          messageNamespace: ref(namespace),
          messages,
          githubEventsVisible: ref(true),
          playRoomSound: () => undefined,
          onMessageSent(message) { messages.value = [...messages.value, message]; },
        }))!;
        const threadDraft = scope.run(() => useDesktopMessageDraft(() => namespace, () => root.id))!;

        await shell.sendRoomMessage("Forbidden thread reply", root.id, [], root.id);
        await shell.sendRoomMessage("Ambiguous network drop", root.id, [], root.id);

        const refused = desktopMessageOutbox.value.find((e) => e.text === "Forbidden thread reply")!;
        const uncertain = desktopMessageOutbox.value.find((e) => e.text === "Ambiguous network drop")!;
        assert.equal(refused.message.outgoing?.status, "refused");
        assert.equal(refused.message.outgoing?.error, "You were removed from this room.");
        assert.equal(uncertain.message.outgoing?.status, "uncertain");

        // Uncertain entries CANNOT be discarded — even if a later retry receives a 403 refusal!
        failAmbiguousWith403 = true;
        await retryDesktopOutgoingMessage(uncertain.clientMessageId);
        assert.equal(uncertain.message.outgoing?.status, "uncertain", "refusal after ambiguous attempt must keep entry uncertain");
        assert.equal(discardRefusedDesktopOutgoingMessage(uncertain.clientMessageId), false);
        assert.ok(desktopMessageOutbox.value.some((e) => e.clientMessageId === uncertain.clientMessageId));

        // Refused entry (never ambiguous) CAN be discarded, removes outbox row with discardAttachments, and restores draft to original thread composer.
        assert.equal(discardRefusedDesktopOutgoingMessage(refused.clientMessageId), true);
        assert.equal(desktopMessageOutbox.value.some((e) => e.clientMessageId === refused.clientMessageId), false);
        assert.equal(threadDraft.text.value, "Forbidden thread reply");
        assert.deepEqual(deletedCalls, [{ id: refused.clientMessageId, options: { discardAttachments: true } }]);
      } finally {
        scope.stop();
      }
    });
    clearDesktopMessageOutbox();
    clearDesktopMessageDrafts();
  });
});

interface HostNode {
  kind: "element" | "text" | "comment";
  type?: string;
  text: string;
  children: HostNode[];
  parent: HostNode | null;
  props: Record<string, unknown>;
}

function makeHostNode(kind: HostNode["kind"], type?: string, text = ""): HostNode {
  return { kind, type, text, children: [], parent: null, props: {} };
}

function collectNodes(node: HostNode, out: HostNode[] = []): HostNode[] {
  out.push(node);
  for (const child of node.children) collectNodes(child, out);
  return out;
}

function nodeText(node: HostNode): string {
  if (node.kind === "text") return node.text;
  const html = typeof node.props.innerHTML === "string" ? node.props.innerHTML : "";
  return html + node.children.map(nodeText).join("");
}

describe("recovery UI accessibility, theming and thread-panel contract", () => {
  let vite: ViteDevServer;
  let DesktopChatMessage: Vue.Component;

  before(async () => {
    Object.assign(globalThis, {
      Document: class Document {},
      ShadowRoot: class ShadowRoot {},
      window: {
        localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
      },
      document: {
        body: makeHostNode("element", "body"),
        visibilityState: "visible",
        hasFocus: () => true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
    vite = await createServer({
      root: desktopRoot,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true },
    });
    DesktopChatMessage = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopChatMessage.vue")).default;
    const DesktopLongMessageContent = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopLongMessageContent.vue")).default;
    for (const [component, modulePath] of [
      [DesktopChatMessage, "components/desktop/content/DesktopChatMessage.vue"],
      [DesktopLongMessageContent, "components/desktop/content/DesktopLongMessageContent.vue"],
    ] as const) {
      const source = await readFile(fileURLToPath(new URL(`../src/${modulePath}`, import.meta.url)), "utf8");
      const descriptor = parse(source, { filename: modulePath }).descriptor;
      assert.ok(descriptor.template);
      const script = compileScript(descriptor, { id: modulePath });
      const compiled = compileTemplate({
        source: descriptor.template.content,
        filename: modulePath,
        id: modulePath,
        compilerOptions: { bindingMetadata: script.bindings },
      });
      assert.deepEqual(compiled.errors, []);
      const clientCode = compiled.code
        .replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`)
        .replace("export function render", "function render");
      const transformed = await transformWithEsbuild(clientCode, `${modulePath}.ts`, { loader: "ts", target: "esnext" });
      (component as { render?: unknown }).render = Function("vue", `${transformed.code}\nreturn render;`)(Vue);
    }
  });

  after(async () => {
    await vite?.close();
  });

  function mountMessage(props: Record<string, unknown>): { root: HostNode; app: App } {
    const teleportTarget = makeHostNode("element", "body");
    const renderer = createRenderer<HostNode, HostNode>({
      createElement: (type) => makeHostNode("element", type),
      createText: (text) => makeHostNode("text", undefined, text),
      createComment: (text) => makeHostNode("comment", undefined, text),
      setText: (node, text) => { node.text = text; },
      setElementText: (node, text) => { node.children = [makeHostNode("text", undefined, text)]; },
      insert: (child, parent, anchor) => {
        child.parent = parent;
        const index = anchor ? parent.children.indexOf(anchor) : -1;
        if (index >= 0) parent.children.splice(index, 0, child);
        else parent.children.push(child);
      },
      remove: (child) => {
        if (!child.parent) return;
        const index = child.parent.children.indexOf(child);
        if (index >= 0) child.parent.children.splice(index, 1);
        child.parent = null;
      },
      patchProp: (el, key, _prev, next) => { el.props[key] = next; },
      parentNode: (node) => node.parent,
      nextSibling: (node) => {
        if (!node.parent) return null;
        const idx = node.parent.children.indexOf(node);
        return idx >= 0 ? node.parent.children[idx + 1] ?? null : null;
      },
      querySelector: () => teleportTarget,
    });
    const root = makeHostNode("element", "div");
    const app = renderer.createApp({ render: () => Vue.h(DesktopChatMessage, { searchActive: false, ...props }) });
    app.provide(ssrContextKey, { modules: new Set() });
    app.mount(root);
    return { root, app };
  }

  it("renders non-color pending, uncertain (with keyboard-accessible Retry), and attachment-only states in timeline and thread-reply contexts", async () => {
    const emptyThreadSummary = {
      count: 0, unreadCount: 0, latest: null, latestPreview: null, latestTimestamp: null,
      participants: [], hasPartialHistory: false, loadingEarlier: false,
    };

    for (const context of ["timeline", "thread-reply"] as const) {
      // Pending attachment-only message: no "No message body." placeholder, attachment chip visible.
      const pendingMsg = roomMessage({
        id: "pending:desktop-send:99999999-9999-4999-8999-999999999999",
        clientMessageId: "desktop-send:99999999-9999-4999-8999-999999999999",
        sender: "You",
        text: "",
        outgoing: {
          status: "pending",
          attachmentCount: 1,
          attachments: [{ upload_id: "local:a1", fileName: "architecture.png", mimeType: "image/png", sizeBytes: 4096 }],
          error: null,
        },
      });
      const pendingView = mountMessage({
        context,
        message: pendingMsg,
        threadSummary: emptyThreadSummary,
        deliveryReceipts: [],
        activeThreadRoot: false,
        highlightQuery: "",
      });
      try {
        const all = collectNodes(pendingView.root);
        const article = all.find((n) => n.type === "article");
        assert.equal(article?.props["data-outgoing-status"], "pending");
        const fullText = nodeText(pendingView.root);
        assert.ok(fullText.includes("Sending…"), `${context}: pending text must be visible without color`);
        assert.ok(fullText.includes("architecture.png"), `${context}: attachment filename must be shown`);
        assert.equal(fullText.includes("No message body."), false, `${context}: attachment-only send must not show 'No message body.'`);
      } finally {
        pendingView.app.unmount();
      }

      // Uncertain message: explicit warning status text + icon + keyboard-accessible native Retry button.
      const uncertainMsg = roomMessage({
        id: "pending:desktop-send:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        clientMessageId: "desktop-send:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sender: "You",
        text: "Recover me after crash",
        outgoing: {
          status: "uncertain",
          attachmentCount: 1,
          attachments: [{ upload_id: "upl_1", fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: 12000 }],
          error: "Delivery could not be confirmed before the app closed.",
        },
      });
      const uncertainView = mountMessage({
        context,
        message: uncertainMsg,
        threadSummary: emptyThreadSummary,
        deliveryReceipts: [],
        activeThreadRoot: false,
        highlightQuery: "",
      });
      try {
        const all = collectNodes(uncertainView.root);
        const article = all.find((n) => n.type === "article");
        assert.equal(article?.props["data-outgoing-status"], "uncertain");
        const retryButton = all.find((n) => n.type === "button" && n.props["data-testid"] === "room-message-outgoing-retry");
        assert.ok(retryButton, `${context}: Retry button must be rendered`);
        assert.equal(retryButton.props.type, "button");
        assert.equal(retryButton.props.disabled, undefined);
        assert.equal(retryButton.props.tabindex, undefined);
        assert.ok(nodeText(retryButton).includes("Retry safely"));
        const discardOnUncertain = all.find((n) => n.type === "button" && n.props["data-testid"] === "room-message-outgoing-discard");
        assert.equal(discardOnUncertain, undefined, `${context}: uncertain send must never offer Discard`);
        const fullText = nodeText(uncertainView.root);
        assert.ok(fullText.includes("Delivery not confirmed"));
        assert.ok(fullText.includes("Recover me after crash"));
        assert.ok(fullText.includes("report.pdf"));
      } finally {
        uncertainView.app.unmount();
      }

      // Definite pre-commit refusal: explicit "Not sent" status + keyboard-accessible Discard & edit + Retry.
      const refusedMsg = roomMessage({
        id: "pending:desktop-send:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        clientMessageId: "desktop-send:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sender: "You",
        text: "Refused draft text",
        outgoing: {
          status: "refused",
          attachmentCount: 0,
          error: "You were removed from this room.",
        },
      });
      const refusedView = mountMessage({
        context,
        message: refusedMsg,
        threadSummary: emptyThreadSummary,
        deliveryReceipts: [],
        activeThreadRoot: false,
        highlightQuery: "",
      });
      try {
        const all = collectNodes(refusedView.root);
        const article = all.find((n) => n.type === "article");
        assert.equal(article?.props["data-outgoing-status"], "refused");
        const discardBtn = all.find((n) => n.type === "button" && n.props["data-testid"] === "room-message-outgoing-discard");
        assert.ok(discardBtn, `${context}: refused send must render Discard button`);
        assert.equal(discardBtn.props.type, "button");
        assert.ok(nodeText(discardBtn).includes("Discard & edit"));
        const fullText = nodeText(refusedView.root);
        assert.ok(fullText.includes("Not sent"));
        assert.ok(fullText.includes("Refused draft text"));
      } finally {
        refusedView.app.unmount();
      }
    }
  });

  it("defines visible focus styling and light/dark theme tokens for outgoing recovery controls", async () => {
    const baseCss = await readFile(fileURLToPath(new URL("../src/styles/01-base.css", import.meta.url)), "utf8");
    const metaCss = await readFile(fileURLToPath(new URL("../src/styles/message-content/message-meta-reply.css", import.meta.url)), "utf8");
    const threadCss = await readFile(fileURLToPath(new URL("../src/styles/message-content/thread-panel.css", import.meta.url)), "utf8");
    assert.match(baseCss, /:root\[data-theme="light"\] \.room-chat-page\s*\{[^}]*color-scheme:\s*light;/);
    assert.match(baseCss, /:root\[data-theme="dark"\] \.room-chat-page\s*\{[^}]*color-scheme:\s*dark;/);
    assert.doesNotMatch(baseCss, /:root\[data-theme="light"\]\s*\{/, "color-scheme: light must stay scoped to chat/opt-in surfaces, not app-wide :root");
    assert.match(metaCss, /\.room-message-outgoing button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--blue-text\)/);
    assert.match(metaCss, /\.room-message-outgoing\[data-tone="warning"\]/);
    assert.match(metaCss, /\.room-chat-message\[data-outgoing-status="uncertain"\]/);
    assert.match(metaCss, /\.room-chat-message\[data-outgoing-status="refused"\]/);
    assert.match(threadCss, /\.room-message-bubble > \.room-thread-marker strong\s*\{[^}]*color:\s*var\(--chat-foreground/);
    assert.match(threadCss, /\.room-thread-panel \.room-chat-message\.is-thread-context \.room-message-author-block strong[\s\S]*?color:\s*var\(--chat-foreground/);
    assert.match(threadCss, /\.room-thread-composer textarea\s*\{[^}]*color:\s*var\(--chat-foreground/);
  });
});

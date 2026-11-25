import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, effectScope, h, nextTick, reactive, ref, ssrContextKey } from "vue";
import { createServer, type ViteDevServer } from "vite";

import type { AgentInspectorProjection } from "../src/domain/agent-inspector";
import { useAgentCorrectionHandoff } from "../src/components/desktop/content/room-shell/useAgentCorrectionHandoff";
import { useRoomShellInspectorRunActions } from "../src/composables/room-shell/useRoomShellInspectorActions";
import { roomShellSource } from "./room-shell-source";

function projection(entryId: string, providerTurnId: string | null): AgentInspectorProjection {
  return {
    entryId,
    displayName: entryId,
    mentionInsertText: entryId,
    resourceFreshness: "fresh",
    turnControl: providerTurnId ? { status: "ready", canCorrect: true, providerTurnId } : null,
    entry: {
      id: entryId, roomId: "room-a", workAttemptId: "attempt", executionGenerationId: "generation",
      providerContinuationId: "session", lastTurnControlSequence: 4,
      roomAgentState: { turn: { state: "working", providerTurnId, inboxItemId: "inbox_1", sourceMessageId: "msg_1" } },
    },
  } as unknown as AgentInspectorProjection;
}

test("Activity can still open the Inspector's correction editor", () => {
  const scope = effectScope();
  const opened: string[] = [];
  const handoff = scope.run(() => useAgentCorrectionHandoff({
    roomIdentifier: () => "room-a",
    projections: () => [projection("busy", "turn_busy"), projection("idle", null)],
    openInspector: (target) => { opened.push(target.entryId); },
  }))!;
  try {
    handoff.openCorrectionOrInspector("busy");
    assert.equal(handoff.correctionRequest.value?.providerTurnId, "turn_busy");
    assert.equal(handoff.correctionRequest.value?.text, "");
    handoff.releaseCorrection();
    handoff.openCorrectionOrInspector("idle");
    assert.deepEqual(opened, ["busy", "idle"]);
    assert.equal(handoff.correctionRequest.value, null);
  } finally { scope.stop(); }
});

test("the composer applies the exact turn through the durable supervisor action", async (t) => {
  const calls: Record<string, unknown>[] = [];
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { letagentsDesktop: { supervisor: {
    controlTurn: async (input: Record<string, unknown>) => { calls.push(input); },
  } } } });
  t.after(() => { Object.assign(globalThis, { window: previousWindow }); });
  const initial = projection("busy", "turn_busy");
  const agentInspectorProjections = ref([initial]);
  const status = { generation: 8 };
  const outcomes: (string | null)[] = [];
  const { steerComposerTurn } = useRoomShellInspectorRunActions({
    props: { room: { identifier: "room-a" } },
    agentInspectorActionState: ref(null),
    supervisorStatus: ref(status),
    agentInspectorProjections,
    refreshSupervisorStatus: async () => status,
    refreshSupervisorEntries: async () => {},
  });
  const request = { entryId: "busy", roomId: "room-a", providerTurnId: "turn_busy", text: "Keep the API stable." };
  const complete = (error: string | null) => { outcomes.push(error); };

  const moved = steerComposerTurn(request, complete);
  agentInspectorProjections.value = [projection("busy", "next_turn")];
  await moved;
  assert.match(outcomes[0]!, /turn has ended or changed/);
  assert.deepEqual(calls, []);

  agentInspectorProjections.value = [initial];
  await steerComposerTurn(request, complete);
  assert.equal(outcomes[1], null);
  assert.deepEqual(calls, [{
    entryId: "busy", roomId: "room-a", providerTurnId: "turn_busy", daemonGeneration: 8,
    workAttemptId: "attempt", executionGenerationId: "generation", providerContinuationId: "session",
    inboxItemId: "inbox_1", sourceMessageId: "msg_1",
    actionId: calls[0]?.actionId, actionSequence: 5, correction: "Keep the API stable.",
  }]);
  assert.match(String(calls[0]?.actionId), /^inspector-turn:[a-f0-9]{64}$/);
});

let vite: ViteDevServer;
let RoomComposer: { setup: (props: object, context: object) => Record<string, any> };
let viteDrafts: typeof import("../src/domain/desktop-message-drafts");
const original = { window: globalThis.window };

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  RoomComposer = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/RoomComposer.vue")).default;
  viteDrafts = await vite.ssrLoadModule("/renderer/src/domain/desktop-message-drafts.ts") as typeof viteDrafts;
});
after(async () => {
  Object.assign(globalThis, original);
  await vite?.close();
});

const renderer = createRenderer<any, any>({
  patchProp() {}, insert(child, parent) { parent.children.push(child); child.parent = parent; }, remove() {},
  createElement: () => ({ children: [] }), createText: () => ({ children: [] }), createComment: () => ({ children: [] }),
  setText() {}, setElementText() {}, parentNode: (node) => node.parent, nextSibling: () => null,
});

/** Composer timers keep the process alive, so a failed assertion must still unmount. */
function withComposer(run: (composer: ReturnType<typeof mountComposer>) => void): void {
  const composer = mountComposer();
  try {
    run(composer);
  } finally {
    composer.stop();
  }
}

function mountComposer() {
  Object.assign(globalThis, { window: Object.assign(new EventTarget(), { letagentsDesktop: {} }) });
  const emitted: Array<[string, ...unknown[]]> = [];
  const props = reactive({
    attaching: false, attachmentDrafts: [], attachmentError: null, messageNamespace: "room-a",
    participants: [], pendingAttachmentDrafts: [], replyTo: null,
    roomIdentifier: "room-a", roomLoading: false, sendError: null, sending: false,
    correctableAgents: [{ entryId: "supervised_busy", providerTurnId: "turn_busy", displayName: "LunarAmber", mentionInsertText: "LunarAmber" }],
  });
  let vm!: Record<string, any>;
  const app = renderer.createApp({
    setup() {
      vm = RoomComposer.setup(props, { expose() {}, emit: (...args: [string, ...unknown[]]) => emitted.push(args) });
      return () => h("div");
    },
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({ children: [] });
  return { vm, props, emitted, stop: () => app.unmount() };
}

test("Steer keeps a refused draft, clears a confirmed draft, and preserves edits made in flight", () => {
  viteDrafts.clearDesktopMessageDrafts();
  withComposer(({ vm, emitted }) => {
    const text = "@LunarAmber keep the API stable";
    vm.draft.value = text;
    assert.equal(vm.steerOffer.value?.target.entryId, "supervised_busy");

    const names: string[] = [];
    const steer = () => {
      vm.steer((name: string) => names.push(name));
      const [event, intent, complete] = emitted.at(-1) as [string, Record<string, unknown>, (error: string | null) => void];
      assert.equal(event, "steer-turn");
      assert.deepEqual(intent, { entryId: "supervised_busy", roomId: "room-a", providerTurnId: "turn_busy", text: "keep the API stable" });
      assert.equal(vm.canSend.value, false, "the same draft can't also be sent to the room while steering");
      assert.equal(vm.draft.value, text);
      return complete;
    };
    steer()("That turn has ended.");
    assert.equal(vm.draft.value, text);
    assert.equal(vm.steerError.value, "That turn has ended.");
    steer()(null);
    assert.equal(vm.draft.value, "");

    vm.draft.value = text;
    const complete = steer();
    vm.draft.value = "My next draft";
    complete(null);
    assert.equal(vm.draft.value, "My next draft");
    assert.deepEqual(names, ["LunarAmber", "LunarAmber"]);
  });
});

test("the composer offers no Steer for a reply, attachments, or a draft that mentions someone else", () => {
  viteDrafts.clearDesktopMessageDrafts();
  withComposer(({ vm, props }) => {
    vm.draft.value = "@LunarAmber stop and rebase on main @HarborMarsh fyi";
    assert.equal(vm.steerOffer.value, null);
    vm.draft.value = "@LunarAmber stop";
    assert.ok(vm.steerOffer.value);
    props.replyTo = { id: "msg_1", sender: "Emmy", text: "earlier" } as never;
    assert.equal(vm.steerOffer.value, null);
    props.replyTo = null;
    props.pendingAttachmentDrafts = [{ id: "upload_1" }] as never;
    assert.equal(vm.steerOffer.value, null);
  });
});

test("the activity line sends through the composer and the room shell", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const lineSource = read("../src/components/desktop/content/room-chat/RoomActivityLine.vue");
  const chatSource = read("../src/components/desktop/content/RoomChatView.vue");
  assert.match(lineSource, /data-testid="desktop-composer-steer"\s*@click="emit\('steer'\)"[\s\S]*?Steer privately/);
  assert.match(lineSource, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(chatSource, /@steer="steerComposerDraft"/);
  assert.match(chatSource, /roomComposer\.value\?\.steer\(roomActivity\.confirmSteer\)/);
  assert.match(roomShellSource(), /@steer-turn="steerComposerTurn"/);
});

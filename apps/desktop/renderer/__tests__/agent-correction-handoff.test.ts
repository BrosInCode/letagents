import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, effectScope, h, nextTick, reactive, ref, ssrContextKey } from "vue";
import { createServer, type ViteDevServer } from "vite";

import type { AgentInspectorProjection } from "../src/domain/agent-inspector";
import {
  captureDesktopMessageDraftRestore,
  clearDesktopMessageDrafts,
  setDesktopMessageDraftAccount,
  useDesktopMessageDraft,
} from "../src/domain/desktop-message-drafts";
import { useAgentCorrectionHandoff } from "../src/components/desktop/content/room-shell/useAgentCorrectionHandoff";

function projection(entryId: string, canCorrect: boolean): AgentInspectorProjection {
  return {
    entryId,
    displayName: entryId,
    mentionInsertText: entryId,
    turnControl: canCorrect ? { status: "ready", canCorrect: true, providerTurnId: `turn_${entryId}` } : null,
  } as unknown as AgentInspectorProjection;
}

/** The handoff as the room shell wires it, in its own scope (the shell's lifetime). */
function shell(roomIdentifier = ref("room-a")) {
  const opened: string[] = [];
  const scope = effectScope();
  const handoff = scope.run(() => {
    const value = useAgentCorrectionHandoff({
      roomIdentifier: () => roomIdentifier.value,
      projections: () => [projection("busy", true), projection("idle", false)],
      openInspector: (target) => {
        opened.push(target.entryId);
        // Opening the Inspector releases the request before it, as the shell does.
        value.releaseCorrection({ restoreComposerText: true });
      },
    });
    return value;
  })!;
  return { handoff, opened, scope, roomIdentifier };
}

function composerText(namespace: string): string {
  const scope = effectScope();
  const text = scope.run(() => useDesktopMessageDraft(() => namespace).text.value)!;
  scope.stop();
  return text;
}

function handOver(handoff: ReturnType<typeof shell>["handoff"], draftNamespace = "room-a"): boolean | null {
  let opened: boolean | null = null;
  handoff.openCorrectionFromComposer(
    { entryId: "busy", text: "stop and rebase", draft: "@busy stop and rebase", draftNamespace },
    (value) => { opened = value; },
  );
  return opened;
}

test("an unapplied hand-over goes back to the composer when the Inspector closes", () => {
  clearDesktopMessageDrafts();
  const { handoff, opened, scope } = shell();
  assert.equal(handOver(handoff), true);
  assert.deepEqual(opened, ["busy"]);
  assert.equal(handoff.correctionRequest.value?.text, "stop and rebase");
  assert.equal(handoff.correctionRequest.value?.providerTurnId, "turn_busy");

  handoff.releaseCorrection({ restoreComposerText: true });
  assert.equal(composerText("room-a"), "@busy stop and rebase");
  assert.equal(handoff.correctionRequest.value, null);
  scope.stop();
});

test("switching rooms writes an unapplied hand-over back into its own room's draft", async () => {
  clearDesktopMessageDrafts();
  const { handoff, scope, roomIdentifier } = shell();
  handOver(handoff);
  roomIdentifier.value = "room-b";
  await nextTick();
  assert.equal(composerText("room-a"), "@busy stop and rebase");
  assert.equal(composerText("room-b"), "");
  scope.stop();
});

test("unmounting the room shell keeps an unapplied hand-over in the room's draft", () => {
  clearDesktopMessageDrafts();
  const { handoff, scope } = shell();
  handOver(handoff);
  // The room shell is keyed per room and unmounts when another room opens.
  scope.stop();
  assert.equal(composerText("room-a"), "@busy stop and rebase");
});

test("a hand-over is dropped, not written into another account's draft, after an account switch", () => {
  setDesktopMessageDraftAccount("account-a");
  const { handoff, scope } = shell();
  handOver(handoff);
  setDesktopMessageDraftAccount("account-b");
  handoff.releaseCorrection({ restoreComposerText: true });
  scope.stop();
  assert.equal(composerText("room-a"), "");
  setDesktopMessageDraftAccount(null);
});

test("a captured draft restore refuses to write once the account or its drafts changed", () => {
  setDesktopMessageDraftAccount("account-a");
  const sameAccount = captureDesktopMessageDraftRestore("room-a");
  assert.equal(sameAccount("kept"), true);
  assert.equal(composerText("room-a"), "kept");

  const afterSwitch = captureDesktopMessageDraftRestore("room-a");
  setDesktopMessageDraftAccount("account-b");
  assert.equal(afterSwitch("lost"), false);

  const afterSignOutClear = captureDesktopMessageDraftRestore("room-a");
  clearDesktopMessageDrafts();
  assert.equal(afterSignOutClear("lost"), false);
  setDesktopMessageDraftAccount(null);
});

test("an applied correction keeps its text out of the composer", () => {
  clearDesktopMessageDrafts();
  const { handoff, scope } = shell();
  handOver(handoff);
  handoff.releaseCorrection({ restoreComposerText: false });
  handoff.releaseCorrection({ restoreComposerText: true });
  scope.stop();
  assert.equal(composerText("room-a"), "");
});

test("an agent without a correctable turn keeps the draft, and Activity still opens its Inspector", () => {
  clearDesktopMessageDrafts();
  const { handoff, opened, scope } = shell();
  let cleared: boolean | null = null;
  handoff.openCorrectionFromComposer({ entryId: "idle", text: "stop", draft: "@idle stop", draftNamespace: "room-a" }, (value) => { cleared = value; });
  assert.equal(cleared, false);
  assert.deepEqual(opened, []);
  // The turn ended between Activity rendering Correct and the click.
  handoff.openCorrectionOrInspector("idle");
  assert.deepEqual(opened, ["idle"]);
  assert.equal(handoff.correctionRequest.value, null);
  assert.deepEqual(handoff.correctableAgents.value.map((target) => target.entryId), ["busy"]);
  scope.stop();
});

test("the room shell releases a hand-over on close and agent switch, and applying never restores it", () => {
  const shellSource = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url)), "utf8");
  const body = (name: string) => shellSource.slice(shellSource.indexOf(`function ${name}(`), shellSource.indexOf("\n}\n", shellSource.indexOf(`function ${name}(`)));
  assert.match(body("closeAgentDetail"), /releaseAgentCorrectionRequest\(\{ restoreComposerText: true \}\)/);
  assert.match(body("openAgentDetailRequest"), /releaseAgentCorrectionRequest\(\{ restoreComposerText: true \}\)/);
  assert.match(shellSource, /if \(intent\.kind === "steer_turn"\) releaseAgentCorrectionRequest\(\{ restoreComposerText: false \}\)/);
  assert.match(shellSource, /useAgentCorrectionHandoff\(\{\s*roomIdentifier: \(\) => props\.room\.identifier,/);
  assert.match(shellSource, /@open-agent-correction="openAgentCorrectionOrInspector"/);
  assert.match(shellSource, /@open-agent-correction="openAgentCorrectionFromComposer"/);
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
    attaching: false, attachmentDrafts: [], attachmentError: null, eventPreviews: [], messageNamespace: "room-a",
    participants: [], pendingAttachmentDrafts: [], permissionApprovals: [], permissionError: null, replyTo: null,
    resolvingPermissionIds: {}, roomIdentifier: "room-a", roomLoading: false, sendError: null, sending: false,
    correctableAgents: [{ entryId: "supervised_busy", displayName: "LunarAmber", mentionInsertText: "LunarAmber" }],
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

test("Send as correction hands over the draft and clears it only once the Inspector opened", () => {
  viteDrafts.clearDesktopMessageDrafts();
  withComposer(({ vm, emitted }) => {
    vm.draft.value = "@LunarAmber stop and rebase on main";
    assert.equal(vm.correctionOffer.value?.target.entryId, "supervised_busy");

    vm.sendAsCorrection();
    const [event, handoff, opened] = emitted.at(-1) as [string, Record<string, unknown>, (value: boolean) => void];
    assert.equal(event, "open-agent-correction");
    assert.deepEqual(handoff, {
      entryId: "supervised_busy",
      text: "stop and rebase on main",
      draft: "@LunarAmber stop and rebase on main",
      draftNamespace: "room-a",
    });
    opened(false);
    assert.equal(vm.draft.value, "@LunarAmber stop and rebase on main", "a refused hand-over keeps the draft");
    opened(true);
    assert.equal(vm.draft.value, "");
  });
});

test("the composer offers no correction for a reply, attachments, or a draft that mentions someone else", () => {
  viteDrafts.clearDesktopMessageDrafts();
  withComposer(({ vm, props }) => {
    vm.draft.value = "@LunarAmber stop and rebase on main @HarborMarsh fyi";
    assert.equal(vm.correctionOffer.value, null);
    vm.draft.value = "@LunarAmber stop";
    assert.ok(vm.correctionOffer.value);
    props.replyTo = { id: "msg_1", sender: "Emmy", text: "earlier" } as never;
    assert.equal(vm.correctionOffer.value, null);
    props.replyTo = null;
    props.pendingAttachmentDrafts = [{ id: "upload_1" }] as never;
    assert.equal(vm.correctionOffer.value, null);
  });
});

test("the offer is announced by a live region that exists before it, and its controls are addressable", () => {
  const composerSource = readFileSync(fileURLToPath(new URL("../src/components/desktop/content/room-chat/RoomComposer.vue", import.meta.url)), "utf8");
  // A live region inserted together with its content is not announced.
  assert.match(composerSource, /<div class="desktop-composer-correction-live" aria-live="polite"[^>]*>\s*<div\s+v-if="correctionOffer"/);
  assert.match(composerSource, /data-testid="desktop-composer-send-as-correction"\s*@click="sendAsCorrection"/);
});

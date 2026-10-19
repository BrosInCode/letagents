import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computed, createSSRApp, h, shallowRef } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";
import * as Vue from "vue";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { transpileModule, ModuleKind } from "typescript";
import type { MessageReaction } from "../../../../shared/message-reactions.mjs";
import type { RoomMessageReactionContext } from "../src/composables/useRoomMessageReactions";

let vite: ViteDevServer;
let DesktopChatMessage: object;
let provideRoomMessageReactions: (context: RoomMessageReactionContext) => void;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  // Both come through the same loader, so they share one injection key.
  DesktopChatMessage = (await vite.ssrLoadModule("/renderer/src/components/desktop/content/DesktopChatMessage.vue")).default;
  ({ provideRoomMessageReactions } = await vite.ssrLoadModule("/renderer/src/composables/useRoomMessageReactions.ts"));
});

after(async () => {
  await vite?.close();
});

const ada = { login: "ada", name: "Ada", avatar_url: null };
const emmy = { login: "emmy", name: "Emmy", avatar_url: null };

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_12",
    sender: "Ada",
    text: "Shall we ship it?",
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: "2026-10-02T12:00:00.000Z",
    actorLabel: null,
    agentIdentity: null,
    threadRootId: "msg_12",
    threadReplyToId: null,
    thread: null,
    replyTo: null,
    reactions: [],
    ...overrides,
  };
}

async function render(options: {
  message: Record<string, unknown>;
  reactions?: MessageReaction[];
  canReact?: boolean;
  provide?: boolean;
}) {
  const tracked: string[] = [];
  const context: RoomMessageReactionContext = {
    revision: shallowRef(0),
    canReact: computed(() => options.canReact ?? true),
    viewerLogin: computed(() => "emmy"),
    reactionsFor: () => options.reactions ?? [],
    viewerReacted: (_messageId, emoji) =>
      Boolean(options.reactions?.find((reaction) => reaction.emoji === emoji)?.reactors.some((reactor) => reactor.login === "emmy")),
    toggle() {},
    track(tracking) {
      tracked.push(tracking.id);
      return () => {};
    },
  };
  const app = createSSRApp({
    setup() {
      if (options.provide !== false) provideRoomMessageReactions(context);
      return () => h(DesktopChatMessage, {
        message: options.message,
        threadSummary: {
          count: 0, unreadCount: 0, latest: null, latestPreview: null, latestTimestamp: null,
          participants: [], hasPartialHistory: false, loadingEarlier: false,
        },
        activeThreadRoot: false,
        highlightQuery: "",
        searchActive: false,
      });
    },
  });
  return { html: await renderToString(app), tracked };
}

test("a message shows its reactions, marks the viewer's own, and offers to add one", async () => {
  const { html, tracked } = await render({
    message: message(),
    reactions: [
      { emoji: "👍", count: 2, reactors: [ada, emmy] },
      { emoji: "🚀", count: 1, reactors: [ada] },
    ],
  });
  assert.deepEqual(tracked, ["msg_12"], "the message registers itself so its reactions stay current");
  assert.match(html, /role="group" aria-label="Reactions"/);
  assert.match(html, /<button[^>]*class="message-reaction"[^>]*aria-pressed="true"[^>]*aria-label="You and Ada reacted with 👍"/);
  assert.match(html, /<button[^>]*class="message-reaction"[^>]*aria-pressed="false"[^>]*aria-label="Ada reacted with 🚀"/);
  assert.equal(html.match(/class="message-reaction-count"[^>]*>(\d+)</g)?.length, 2);
  assert.match(html, /class="message-reaction message-reaction-add"[^>]*aria-expanded="false"/);
  assert.match(html, /class="room-message-reply-action room-message-react-action"[^>]*aria-expanded="false"/);
  assert.match(html, /room-message-react-action/, "the hover toolbar offers the picker too");
});

test("a message without reactions shows no bar but can still be reacted to", async () => {
  const { html } = await render({ message: message() });
  assert.doesNotMatch(html, /class="message-reactions"/);
  assert.match(html, /room-message-react-action/);
});

test('a loading GIF-only message hides its fallback prose, while a GIF with ordinary text keeps that text', async () => {
  const gif = { provider: 'giphy', id: 'celebration', title: 'Celebration', text_fallback_only: true };
  const fallback = await render({ message: message({ text: 'This is only the textual fallback.', gif }) });
  assert.match(fallback.html, /room-gif-placeholder/);
  assert.doesNotMatch(fallback.html, /This is only the textual fallback\./);
  const caption = await render({ message: message({ text: 'Our first milestone is complete.', gif: { ...gif, text_fallback_only: undefined } }) });
  assert.match(caption.html, /Our first milestone is complete\./);
  assert.match(caption.html, /room-gif-placeholder/);
});

test("someone who cannot react sees the reactions without any control", async () => {
  const { html } = await render({
    message: message(),
    reactions: [{ emoji: "👍", count: 1, reactors: [ada] }],
    canReact: false,
  });
  assert.match(html, /<span[^>]*class="message-reaction"[^>]*role="img"[^>]*aria-label="Ada reacted with 👍"/);
  assert.doesNotMatch(html, /<button[^>]*class="message-reaction/);
  assert.doesNotMatch(html, /room-message-react-action|message-reaction-add/);
});

test("messages the server sent without reactions, unsent messages and wake notices cannot be reacted to", async () => {
  const withoutField = message();
  delete (withoutField as Record<string, unknown>).reactions;
  for (const candidate of [
    withoutField,
    message({ id: "desktop-send:1", outgoing: { status: "pending", attachmentCount: 0, error: null } }),
    message({ source: "wake_rule" }),
  ]) {
    const { html } = await render({ message: candidate });
    assert.doesNotMatch(html, /room-message-react-action|message-reaction-add/, JSON.stringify(candidate.id));
  }
});

test("outside a room that provides reactions the message renders as before", async () => {
  const { html, tracked } = await render({ message: message(), provide: false });
  assert.deepEqual(tracked, []);
  assert.doesNotMatch(html, /message-reaction|room-message-react-action/);
  assert.match(html, /aria-label="Copy message"/);
});


test("the shared add button exposes the open and closed picker state", async () => {
  const Bar = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/MessageReactionBar.vue", import.meta.url)))).default;
  for (const pickerOpen of [false, true]) {
    const html = await renderToString(createSSRApp({ render: () => h(Bar, {
      reactions: [{ emoji: "👍", count: 1, reactors: [ada] }],
      canReact: true, viewerLogin: "emmy", viewerReacted: () => false, pickerOpen,
    }) }));
    assert.match(html, new RegExp(`class="message-reaction message-reaction-add"[^>]*aria-expanded="${pickerOpen}"`));
  }
});

test("hover anywhere on a reaction or focus it to see every supplied name; Escape and unmount dismiss details", async () => {
  class Host {
    children: Host[] = []; parent: Host | null = null; props: Record<string, any> = {}; text = ""; isConnected = true;
    constructor(public type = "") { Vue.markRaw(this); }
    contains(other: Host): boolean { return this === other || this.children.some(child => child.contains(other)); }
    getBoundingClientRect() { return { left: 20, right: 220, top: 300, bottom: 324, width: 200, height: 80 }; }
  }
  const root = new Host("root"), body = new Host("body"), listeners = new Map<string, Function>();
  const priorWindow = globalThis.window;
  Object.assign(globalThis, { window: { innerWidth: 1000, innerHeight: 800,
    addEventListener: (name: string, fn: Function) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name) } });
  const renderer = Vue.createRenderer<Host, Host>({
    patchProp: (node, key, _old, value) => { node.props[key] = value; },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at < 0) parent.children.push(child); else parent.children.splice(at, 0, child); child.parent = parent; },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
    createElement: tag => new Host(tag), createText: text => Object.assign(new Host(), { text }),
    createComment: text => Object.assign(new Host(), { text }), setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; }, parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null, querySelector: () => body,
    insertStaticContent(content, parent, anchor) {
      const node = Object.assign(new Host("static"), { text: content, parent });
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at < 0) parent.children.push(node); else parent.children.splice(at, 0, node);
      return [node, node];
    },
  });
  const path = fileURLToPath(new URL("../../../../shared/ui/MessageReactionBar.vue", import.meta.url));
  const Bar = (await vite.ssrLoadModule(path)).default;
  const descriptor = parse(readFileSync(path, "utf8")).descriptor;
  const bindings = compileScript(descriptor, { id: "reaction-hover" }).bindings;
  const template = compileTemplate({ source: descriptor.template!.content, filename: path, id: "reaction-hover", compilerOptions: { bindingMetadata: bindings } });
  assert.deepEqual(template.errors, []);
  const code = transpileModule(template.code, { compilerOptions: { module: ModuleKind.ESNext } }).outputText
    .replace(/import \{([\s\S]*?)\} from "vue";/g, (_all, names: string) => `const {${names.replace(/\s+as\s+/g, ": ")}} = vue;`)
    .replace("export function render", "function render");
  const ClientBar = { ...Bar, render: Function("vue", code + "\nreturn render;")(Vue) };
  const names = Array.from({ length: 8 }, (_, index) => ({ login: `agent-${index}`, name: `Agent ${index}`, avatar_url: null }));
  const app = renderer.createApp(ClientBar, { reactions: [{ emoji: "👍", count: 9, reactors: [...names, emmy] }],
    viewerLogin: "emmy", viewerReacted: () => true, canReact: true });
  app.provide(Vue.ssrContextKey, { modules: new Set() });
  const descendants = (node: Host): Host[] => [node, ...node.children.flatMap(descendants)];
  const tooltip = () => descendants(body).find(node => node.props.role === "tooltip");
  try {
    app.mount(root); await Vue.nextTick();
    const chip = descendants(root).find(node => node.props.class === "message-reaction")!;
    // Handler is on the full chip, even when the actual pointer target is its emoji child.
    await chip.props.onPointerenter({ currentTarget: chip, target: chip.children[0] }); await Vue.nextTick();
    for (const person of names) assert.ok(tooltip()!.text.includes(person.name));
    assert.ok(tooltip()!.text.includes("You"));
    assert.equal(tooltip()!.props.style.visibility, "visible");
    listeners.get("keydown")!({ key: "Escape" }); await Vue.nextTick(); assert.equal(tooltip(), undefined);
    await chip.props.onFocus({ currentTarget: chip }); await Vue.nextTick(); assert.ok(tooltip());
    listeners.get("scroll")!({ target: body }); await Vue.nextTick(); assert.equal(tooltip(), undefined);
    await chip.props.onFocus({ currentTarget: chip }); await Vue.nextTick();
  } finally { app.unmount(); Object.assign(globalThis, { window: priorWindow }); }
  assert.equal(tooltip(), undefined); assert.equal(listeners.size, 0);
});

test("picker source keeps scroll placement in a cancellable animation frame and restores focus on Tab exit", () => {
  const picker = readFileSync(new URL("../../../../shared/ui/MessageReactionPicker.vue", import.meta.url), "utf8");
  assert.match(picker, /if \(frame !== null \|\| !listening\) return/);
  assert.match(picker, /requestAnimationFrame\(\(\) => \{\s*frame = null;\s*place\(\)/);
  assert.equal(picker.match(/source\.element\.getBoundingClientRect\(\)/g)?.length, 1, "one live-anchor read in the placement callback");
  assert.match(picker, /!source\.element\.isConnected/);
  assert.match(picker, /scrollViewport = nearestScrollViewport\(anchor\.element\)/);
  assert.match(picker, /for \(let parent = element\.parentElement; parent; parent = parent\.parentElement\)/);
  assert.ok(picker.includes('/^(auto|scroll)$/.test(window.getComputedStyle(parent).overflowY)'));
  assert.equal(picker.match(/scrollViewport\?\.getBoundingClientRect\(\)/g)?.length, 1);
  assert.match(picker, /Math\.max\(0, clip\?\.top \?\? 0\)/);
  assert.match(picker, /Math\.min\(viewportHeight, clip\?\.bottom \?\? viewportHeight\)/);
  assert.match(picker, /anchor\.bottom <= visible\.top \|\| anchor\.top >= visible\.bottom/);
  assert.match(picker, /anchor\.right <= visible\.left \|\| anchor\.left >= visible\.right/);
  assert.match(picker, /const anchor = pointOffset[\s\S]*?top: rect\.top \+ pointOffset\.y, bottom: rect\.top \+ pointOffset\.y/);
  assert.ok(picker.indexOf('const anchor = pointOffset') < picker.indexOf('anchor.bottom <= visible.top'), 'clipping checks the anchored point for a context menu');
  assert.doesNotMatch(picker, /IntersectionObserver/);
  for (const [event, handler, capture] of [
    ["scroll", "schedulePlace", ", true"], ["resize", "schedulePlace", ""],
    ["pointerdown", "dismissUnlessInside", ", true"], ["blur", "dismiss", ""],
  ]) {
    assert.ok(picker.includes(`window.addEventListener("${event}", ${handler}${capture})`));
    assert.ok(picker.includes(`window.removeEventListener("${event}", ${handler}${capture})`));
  }
  assert.match(picker, /cancelAnimationFrame\(frame\)/);
  assert.match(picker, /!anchor && previous\) \{\s*listen\(false\)/);
  assert.match(picker, /onBeforeUnmount\(\(\) => listen\(false\)\)/);
  assert.match(picker, /event\.key === "Tab" && \(event\.shiftKey \? !inInput : inInput\)\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*emit\("close", true\)/);
  const host = readFileSync(new URL("../src/components/desktop/content/DesktopChatMessage.vue", import.meta.url), "utf8");
  assert.match(host, /:picker-open="reactionPickerAnchor !== null"/);
  assert.match(host, /showReactionPicker\(\{ element: trigger \}/);
  assert.match(host, /element: messageElement\.value, point: \{ x, y \}/);
  assert.match(host, /if \(restoreFocus && invoker\?\.isConnected\) invoker\.focus\(\{ preventScroll: true \}\)/);
});

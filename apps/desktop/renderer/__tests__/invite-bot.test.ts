import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, effectScope, h, nextTick, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

import {
  DEFAULT_INVITE_BOT_CONNECTOR_URL,
  INVITE_BOT_GIT_ROOM_LINE,
  INVITE_BOT_HINT,
  INVITE_BOT_PLATFORMS,
  inviteBotConnectorUrl,
  nextCopyStateLook,
  useInviteBotSection,
  type InviteBotInviteState,
} from "../../../../shared/ui/invite-bot";
import { remoteConnectorUrl } from "../src/components/desktop/settings/connectors";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const room = { roomId: "PTGA-21RN-W0QP", roomName: "sky-owl", connectorUrl: "https://letagents.chat/mcp" };
const neverCalled = async () => { throw new Error("not in this test"); };

test("the picker lists the four bots in order, and the hint is one line", () => {
  assert.deepEqual(INVITE_BOT_PLATFORMS.map((choice) => [choice.id, choice.label]), [
    ["grok", "Grok Bot"], ["chatgpt", "ChatGPT"], ["claude", "Claude"], ["other", "Other"],
  ]);
  assert.equal(INVITE_BOT_HINT, "Send this to the bot's owner.");
  assert.equal(INVITE_BOT_GIT_ROOM_LINE, "Bots join invite rooms, not Git Rooms.");
});

test("the connector address is this server's /mcp, and the public server when the origin is unknown", () => {
  assert.equal(inviteBotConnectorUrl("https://letagents.chat"), "https://letagents.chat/mcp");
  assert.equal(inviteBotConnectorUrl("https://chat.herotel.example/"), "https://chat.herotel.example/mcp");
  assert.equal(inviteBotConnectorUrl("http://localhost:5174"), "http://localhost:5174/mcp");
  assert.equal(inviteBotConnectorUrl(null), DEFAULT_INVITE_BOT_CONNECTOR_URL);
  assert.equal(inviteBotConnectorUrl(""), DEFAULT_INVITE_BOT_CONNECTOR_URL);
  assert.equal(inviteBotConnectorUrl("file:///Users/ada"), DEFAULT_INVITE_BOT_CONNECTOR_URL, "a packaged renderer has no web origin");
  assert.equal(inviteBotConnectorUrl("not a url"), DEFAULT_INVITE_BOT_CONNECTOR_URL);
  assert.equal(remoteConnectorUrl("https://chat.herotel.example"), "https://chat.herotel.example/mcp");
  assert.equal(remoteConnectorUrl(null), "https://letagents.chat/mcp");
});

test("the Copy label animates its words only when Copy and Copied swap, so the first press shows no false Copied", () => {
  // The first press: the spinner comes while the code is made. The "Copy" unit stays; nothing animates.
  let look = nextCopyStateLook({ shown: "idle", changed: false }, "busy");
  assert.deepEqual(look, { shown: "busy", changed: false });
  // A failed make goes back to Copy: still the same unit.
  assert.deepEqual(nextCopyStateLook(look, "idle"), { shown: "idle", changed: false });
  // The code is copied: the units swap, and from now on the swaps animate.
  look = nextCopyStateLook(look, "done");
  assert.deepEqual(look, { shown: "done", changed: true });
  assert.deepEqual(nextCopyStateLook(look, "idle"), { shown: "idle", changed: true });
  assert.deepEqual(nextCopyStateLook({ shown: "idle", changed: false }, "done"), { shown: "done", changed: true }, "a fast answer swaps at once");

  // Why it matters: under data-changed every unit runs an animation, and the leave
  // animation starts from full view. Only a swap may add it, never the spinner.
  const css = source("../../../../shared/ui/invite-bot-parts.css");
  assert.match(css, /\.copy-state\[data-changed\] \.copy-state-unit \{\s*animation: copy-state-out/);
  assert.match(css, /@keyframes copy-state-out \{\s*from \{\s*opacity: 1;/);
  // Reduced motion: as specific as the "in" rules (five parts) and later in the file, so the words only cross-fade.
  assert.match(css, /\.copy-state\[data-changed\]\[data-state="idle"\] \.copy-state-unit\[data-for="idle"\]/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.copy-state\[data-changed\]\[data-state\] \.copy-state-unit\[data-for\],[\s\S]*?animation: none;\s*transition: opacity 150ms ease;/);
  const label = source("../../../../shared/ui/CopyStateLabel.vue");
  assert.match(label, /nextCopyStateLook\(\{ shown: shown\.value, changed: changed\.value \}, next\)/);
  assert.doesNotMatch(label, /changed\.value = true/, "the label never marks a change by itself");
});

/** The section's state, run for real: a fake server and clipboard, the host's invite state in a ref. */
function sectionHarness(options: { clipboardWorks?: boolean } = {}) {
  const made: string[] = [];
  const cancels: string[] = [];
  const done: number[] = [];
  let next = 0;
  let clipboardWorks = options.clipboardWorks ?? true;
  let cancelAnswer: string | null = null;
  const hostState = ref<InviteBotInviteState | null>(null);
  const scope = effectScope();
  const section = scope.run(() => useInviteBotSection({
    room: ref({ roomId: "PTGA-21RN-W0QP", roomName: "sky-owl", connectorUrl: "https://letagents.chat/mcp" }),
    createInvite: async (platform) => {
      next += 1;
      return { invite: { id: `inv_${next}`, platform, kind: "admit", room_id: "PTGA-21RN-W0QP" }, code: `CODE-000${next}` };
    },
    cancelInvite: () => async (inviteId) => {
      cancels.push(inviteId);
      return cancelAnswer;
    },
    inviteState: () => hostState.value,
    writeClipboard: async () => {
      if (!clipboardWorks) throw new Error("blocked");
    },
    onMade: (inviteId) => { made.push(inviteId); },
    onDone: () => { done.push(1); },
  }))!;
  return {
    section, made, cancels, done, hostState, scope,
    setClipboard(works: boolean) { clipboardWorks = works; },
    answerCancel(sentence: string | null) { cancelAnswer = sentence; },
  };
}

test("the section shows one error, the newest: a cancel refusal is not hidden behind an old copy error", async () => {
  const h = sectionHarness({ clipboardWorks: false });
  await h.section.copy();
  assert.equal(h.section.invite.created.value?.code, "CODE-0001", "the code is made even when the clipboard refuses");
  assert.equal(h.section.error.value, "The message could not be copied. Select it and copy it by hand.");

  // The bot used the code meanwhile; Cancel is refused. The refusal shows, not the old copy error.
  h.answerCancel("This invite is already used.");
  await h.section.cancel();
  assert.deepEqual(h.cancels, ["inv_1"]);
  assert.equal(h.section.error.value, "This invite is already used.");
  assert.equal(h.section.invite.created.value?.code, "CODE-0001", "a refused cancel keeps the code on screen");

  // Copy again: the cancel refusal goes; a copy that works shows no error.
  h.setClipboard(true);
  await h.section.copy();
  assert.equal(h.section.error.value, null);
  h.scope.stop();
});

test("joined is about the invite on screen; New invite makes a fresh code; Done tells the host", async () => {
  const h = sectionHarness();
  h.hostState.value = { state: "used", outcome: "admitted" };
  assert.equal(h.section.joined.value, false, "no invite on screen, so nothing joined");

  await h.section.copy();
  h.hostState.value = { state: "used", outcome: "admitted" };
  assert.equal(h.section.joined.value, true);

  // "New invite": Copy on a joined invite starts over with a new code.
  await h.section.copy();
  assert.deepEqual(h.made, ["inv_1", "inv_2"]);
  assert.equal(h.section.invite.created.value?.code, "CODE-0002");

  h.section.close();
  assert.equal(h.section.invite.created.value, null);
  assert.equal(h.section.joined.value, false, "a closed section shows nothing old");
  assert.deepEqual(h.done, [1]);
  h.scope.stop();
});

test("a code cancelled elsewhere goes, also while another bot is picked, so it never comes back", async () => {
  const h = sectionHarness();
  await h.section.copy();
  h.hostState.value = { state: "open", outcome: null };
  h.section.pick("chatgpt");
  assert.equal(h.section.invite.created.value, null, "another bot shows no code");

  h.hostState.value = { state: "cancelled", outcome: null };
  await nextTick();
  h.section.pick("grok");
  assert.equal(h.section.invite.created.value, null, "the cancelled code does not come back with Grok Bot");
  assert.equal(h.section.invite.lastMade.value, null);

  // On screen when it is cancelled elsewhere: the code goes and the section says so.
  await h.section.copy();
  h.hostState.value = { state: "open", outcome: null };
  await nextTick();
  h.hostState.value = { state: "cancelled", outcome: null };
  await nextTick();
  assert.equal(h.section.invite.created.value, null);
  assert.equal(h.section.cancelled.value, true);

  // Its own cancel: the code goes too.
  await h.section.copy();
  h.answerCancel(null);
  await h.section.cancel();
  assert.equal(h.section.invite.created.value, null);
  assert.equal(h.section.cancelled.value, true);
  assert.equal(h.section.error.value, null);
  h.scope.stop();
});

test("the section component uses the shared state and shows its one error line", () => {
  const section = source("../../../../shared/ui/InviteBotSection.vue");
  assert.match(section, /const section = useInviteBotSection\(\{/);
  assert.match(section, /<p v-if="error" class="invite-bot-error" role="alert" data-testid="invite-bot-error">\{\{ error \}\}<\/p>/);
  assert.match(section, /onDone: \(\) => emit\("done"\)/);
});

let vite: ViteDevServer;
let InviteBotSection: object;
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  InviteBotSection = (await vite.ssrLoadModule(fileURLToPath(new URL("../../../../shared/ui/InviteBotSection.vue", import.meta.url)))).default;
});
after(async () => {
  await vite?.close();
});

async function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(InviteBotSection, { room, createInvite: neverCalled, ...props }) }));
}

test("the section shows one button until opened; open, it says what the invite does, then the picker, the message with a placeholder, and Copy", async () => {
  // Closed: one line and one quiet button, like the drawer panels around it (not a second "Invite a bot").
  const closed = await render({ admin: true });
  assert.match(closed, /class="invite-bot-closed"><p class="invite-bot-hint">A one-use code that lets a bot into this room\.<\/p>/);
  assert.match(closed, /data-testid="invite-bot-open"[^>]*>\s*Create\s*</);
  assert.doesNotMatch(closed, /data-variant="primary"[^>]*data-testid="invite-bot-open"/);
  assert.match(await render({}), /A one-use code that asks an admin to let a bot in\./);
  assert.doesNotMatch(closed, /data-testid="invite-bot-picker"/);

  const open = await render({ collapsible: false, admin: true });
  assert.doesNotMatch(open, /data-testid="invite-bot-open"/);
  // Vue's SSR writes quotes and apostrophes as entities.
  assert.match(open, /data-testid="invite-bot-summary"[^>]*>The bot joins (&quot;|")sky-owl(&quot;|") at once, with no approval\. The invite works one time\.</);
  // A radio group: the picked bot is the one stop for Tab, arrow keys move it.
  assert.match(open, /role="radiogroup" aria-label="Which bot"/);
  const radios = [...open.matchAll(/data-platform="([a-z]+)"[^>]*aria-checked="(true|false)"[^>]*tabindex="(-?\d)"/g)].map((match) => [match[1], match[2], match[3]]);
  assert.deepEqual(radios, [["grok", "true", "0"], ["chatgpt", "false", "-1"], ["claude", "false", "-1"], ["other", "false", "-1"]], "Grok Bot is picked first");
  // Every bot's message sits in one cell (the box never changes height); only the picked one is shown and read.
  const layers = [...open.matchAll(/class="invite-bot-msg-layer"([^>]*)data-platform="([a-z]+)"/g)].map((match) => [match[2], /data-active/.test(match[1]), /aria-hidden="true"/.test(match[1])]);
  assert.deepEqual(layers, [["grok", true, false], ["chatgpt", false, true], ["claude", false, true], ["other", false, true]]);
  assert.match(open, /Paste this to your Grok Bot:/);
  assert.match(open, /class="invite-bot-msg-address"[^>]*>https:\/\/letagents\.chat\/mcp</);
  assert.match(open, /class="invite-bot-msg-code" data-placeholder/, "the code is made when Copy is pressed");
  assert.doesNotMatch(open, /For the room/, "the message names no room");
  // Copy keeps one width: both words share one cell, the icon turns into a check.
  // Icon and word are one unit each, centred in one cell: "⧉ Copy" and "✓ Copied".
  assert.match(open, /data-testid="invite-bot-copy"[\s\S]*?class="copy-state" data-state="idle"[\s\S]*?data-for="idle"[\s\S]*?class="copy-state-copy"[\s\S]*?<span>Copy<\/span>[\s\S]*?data-for="done"[\s\S]*?class="copy-state-check"[\s\S]*?<span>Copied<\/span>/);
  assert.match(open, /Send this to the bot(&#39;|')s owner\./);
  assert.doesNotMatch(open, />\s*Done\s*</, "a host that opens it closes it too");
  assert.match(await render({ initialPlatform: "claude", collapsible: false }), /data-active[^>]*data-platform="claude"[\s\S]*?In Claude(&#39;|')s Settings → Connectors, add:/);

  const member = await render({ collapsible: false, admin: false });
  assert.match(member, /An admin of (&quot;|")sky-owl(&quot;|") lets the bot in\. The invite works one time\./);
});

test("a Git Room's section says bots join invite rooms and where to go, and offers no invite", async () => {
  const git = await render({ gitRoom: true, gitRoomHint: "Press + in the composer and choose Invite a bot to pick an invite room." });
  assert.match(git, /data-testid="invite-bot-git-room"[^>]*>Bots join invite rooms, not Git Rooms\. Press \+ in the composer and choose Invite a bot to pick an invite room\.</);
  assert.doesNotMatch(git, /invite-bot-open|invite-bot-picker|invite-bot-copy/);
});

test("Room settings → Bot makes invites through the desktop store, so its pill shows above the composer", () => {
  const panel = source("../src/components/desktop/content/room-shell/DesktopRoomActionPanel.vue");
  assert.match(panel, /import InviteBotSection from "(\.\.\/)+shared\/ui\/InviteBotSection\.vue";/);
  assert.match(panel, /<section v-if="cloudRoom" class="room-settings-section" data-section="bot" aria-labelledby="room-settings-heading-bot">\s*<h3 id="room-settings-heading-bot">Bot<\/h3>/);
  assert.match(panel, /data-testid="desktop-room-invite-bot-toggle"\s+:aria-expanded="inviteBotOpen"[\s\S]*?>\{\{ inviteBotOpen \? "Close" : "Create invite" \}\}<\/button>/);
  assert.match(panel, /<InviteBotSection\s+v-if="inviteBotOpen"\s+class="room-invite-bot-body"[\s\S]*?:git-room="room\.gitRoom !== null"[\s\S]*?:collapsible="false"\s+:create-invite="createInviteBot"\s+:cancel-invite="cancelInviteBot"\s+:invite-state="madeInviteState"\s+@made="madeInviteId = \$event"\s*\/>/);
  // The section follows the invite it made through the store: "joined" once the bot is in.
  assert.match(panel, /const invite = madeInviteId\.value \? roomInvites\.invites\.value\.get\(madeInviteId\.value\) : null;/);
  assert.match(panel, /const made = await roomInvites\.create\(props\.room\.identifier, platform, null\);\s*roomInvites\.reveal\(\[made\.invite\.id\]\);/);
  // The connector is the API this app talks to, not the room link's public origin.
  assert.match(panel, /connectorUrl: remoteConnectorUrl\(props\.apiUrl\)/);
  assert.match(panel, /\.room-invite-bot-body \{\s*grid-column: 1 \/ -1;\s*\}/);
  // Bot is its own section after Members.
  assert.ok(panel.indexOf('<RoomMembers v-if="cloudRoom"') < panel.indexOf('data-section="bot"'));
  assert.ok(panel.indexOf('data-section="bot"') < panel.indexOf('data-section="conversation"'));
  assert.match(source("../src/App.vue"), /<DesktopRoomShell\s+[^>]*:api-url="appInfo\?\.apiUrl \?\? null"/);
});

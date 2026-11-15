import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

import {
  DEFAULT_INVITE_BOT_CONNECTOR_URL,
  INVITE_BOT_GIT_ROOM_LINE,
  INVITE_BOT_HINT,
  INVITE_BOT_PLATFORMS,
  inviteBotConnectorUrl,
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
  const closed = await render({});
  assert.match(closed, /data-testid="invite-bot-open"[^>]*>\s*Invite a bot\s*</);
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
  assert.match(open, /data-testid="invite-bot-copy"[\s\S]*?class="copy-state" data-state="idle"[\s\S]*?data-for="idle"[^>]*>Copy<[\s\S]*?data-for="done"[^>]*>Copied</);
  assert.match(open, /Send this to the bot(&#39;|')s owner\./);
  assert.doesNotMatch(open, />\s*Done\s*</, "a host that opens it closes it too");
  assert.match(await render({ initialPlatform: "claude", collapsible: false }), /data-active[^>]*data-platform="claude"[\s\S]*?In Claude, add this connector/);

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
  assert.match(panel, /<InviteBotSection\s+v-if="inviteBotOpen"\s+class="room-invite-bot-body"[\s\S]*?:git-room="room\.gitRoom !== null"[\s\S]*?:collapsible="false"\s+:create-invite="createInviteBot"\s+:cancel-invite="cancelInviteBot"\s*\/>/);
  assert.match(panel, /const made = await roomInvites\.create\(props\.room\.identifier, platform, null\);\s*roomInvites\.reveal\(\[made\.invite\.id\]\);/);
  // The connector is the API this app talks to, not the room link's public origin.
  assert.match(panel, /connectorUrl: remoteConnectorUrl\(props\.apiUrl\)/);
  assert.match(panel, /\.room-invite-bot-body \{\s*grid-column: 1 \/ -1;\s*\}/);
  // Bot is its own section after Members.
  assert.ok(panel.indexOf('<RoomMembers v-if="cloudRoom"') < panel.indexOf('data-section="bot"'));
  assert.ok(panel.indexOf('data-section="bot"') < panel.indexOf('data-section="conversation"'));
  assert.match(source("../src/App.vue"), /<DesktopRoomShell\s+[^>]*:api-url="appInfo\?\.apiUrl \?\? null"/);
});

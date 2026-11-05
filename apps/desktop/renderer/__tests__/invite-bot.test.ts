import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp, h, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

import {
  DEFAULT_INVITE_BOT_CONNECTOR_URL,
  INVITE_BOT_APPROVE_HINT,
  INVITE_BOT_HINT,
  INVITE_BOT_PLATFORMS,
  buildInviteBotMessage,
  inviteBotConnectorUrl,
  inviteBotRoomLabel,
  useInviteBot,
  type InviteBotRoom,
} from "../../../../shared/ui/invite-bot";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const adHoc: InviteBotRoom = { roomId: "PTGA-21RN-W0QP", roomName: "Sky Owl", gitRoom: false, connectorUrl: "https://letagents.chat/mcp" };
const gitRoom: InviteBotRoom = { roomId: "github.com/brosincode/letagents", roomName: "github.com/brosincode/letagents", gitRoom: true, connectorUrl: "https://letagents.chat/mcp" };

test("the picker lists the four bots in order", () => {
  assert.deepEqual(INVITE_BOT_PLATFORMS.map((choice) => [choice.id, choice.label]), [
    ["grok", "Grok Bot"], ["chatgpt", "ChatGPT"], ["claude", "Claude"], ["other", "Other"],
  ]);
  assert.equal(INVITE_BOT_HINT, "Send this to the bot's owner. They paste it to their bot.");
  assert.equal(INVITE_BOT_APPROVE_HINT, "When the bot asks to join, approve it under Members.");
});

test("the connector address is this server's /mcp, and the public server when the origin is unknown", () => {
  assert.equal(inviteBotConnectorUrl("https://letagents.chat"), "https://letagents.chat/mcp");
  assert.equal(inviteBotConnectorUrl("https://chat.herotel.example/"), "https://chat.herotel.example/mcp");
  assert.equal(inviteBotConnectorUrl("http://localhost:5174"), "http://localhost:5174/mcp");
  assert.equal(inviteBotConnectorUrl(null), DEFAULT_INVITE_BOT_CONNECTOR_URL);
  assert.equal(inviteBotConnectorUrl(""), DEFAULT_INVITE_BOT_CONNECTOR_URL);
  assert.equal(inviteBotConnectorUrl("file:///Users/ada"), DEFAULT_INVITE_BOT_CONNECTOR_URL, "a packaged renderer has no web origin");
  assert.equal(inviteBotConnectorUrl("not a url"), DEFAULT_INVITE_BOT_CONNECTOR_URL);
});

test("the room is named by its id, with its name after it when the name differs", () => {
  assert.equal(inviteBotRoomLabel(adHoc), "PTGA-21RN-W0QP (Sky Owl)");
  assert.equal(inviteBotRoomLabel({ roomId: "PTGA-21RN-W0QP", roomName: "PTGA-21RN-W0QP" }), "PTGA-21RN-W0QP");
  assert.equal(inviteBotRoomLabel({ roomId: "PTGA-21RN-W0QP", roomName: null }), "PTGA-21RN-W0QP");
  assert.equal(inviteBotRoomLabel(gitRoom), "github.com/brosincode/letagents");
});

test("each bot gets its own message with the connector address and the room code filled in", () => {
  assert.equal(buildInviteBotMessage("grok", adHoc),
    "Paste this to your Grok Bot:\n"
    + "Connect to LetAgents at https://letagents.chat/mcp and sign me in. Then join the room PTGA-21RN-W0QP (Sky Owl) and say hi. "
    + "If the room asks you to request access, do it and tell me.");
  assert.equal(buildInviteBotMessage("chatgpt", adHoc),
    "In ChatGPT, add a custom connector with the URL https://letagents.chat/mcp (sign in with GitHub when it asks). "
    + "Then tell ChatGPT: Join the LetAgents room PTGA-21RN-W0QP (Sky Owl) and say hi. "
    + "If the room asks you to request access, do it and tell me.");
  assert.equal(buildInviteBotMessage("claude", adHoc),
    "In Claude, add the connector https://letagents.chat/mcp (Settings → Connectors) and sign in. "
    + "Then tell Claude: Join the LetAgents room PTGA-21RN-W0QP (Sky Owl) and say hi. "
    + "If the room asks you to request access, do it and tell me.");
  assert.equal(buildInviteBotMessage("other", adHoc),
    "Connector address: https://letagents.chat/mcp (sign in with GitHub when it asks).\n"
    + "Room code: PTGA-21RN-W0QP (Sky Owl).\n"
    + "Tell your bot to join the room PTGA-21RN-W0QP (Sky Owl) and say hi. If the room asks you to request access, do it and tell me.");

  // A self-hosted server names its own connector; no connector given means the public one.
  assert.match(buildInviteBotMessage("grok", { ...adHoc, connectorUrl: "https://chat.herotel.example/mcp" }), /Connect to LetAgents at https:\/\/chat\.herotel\.example\/mcp /);
  assert.match(buildInviteBotMessage("claude", { ...adHoc, connectorUrl: null }), /add the connector https:\/\/letagents\.chat\/mcp /);
});

test("a Git Room's message names the repository room and the GitHub role, and does not tell the bot to ask for access", () => {
  const grok = buildInviteBotMessage("grok", gitRoom);
  assert.equal(grok,
    "Paste this to your Grok Bot:\n"
    + "Connect to LetAgents at https://letagents.chat/mcp and sign me in. Then join the repository room github.com/brosincode/letagents and say hi. "
    + "You need a role on that GitHub repository.");
  assert.match(buildInviteBotMessage("chatgpt", gitRoom), /Join the LetAgents repository room github\.com\/brosincode\/letagents and say hi\. You need a role on that GitHub repository\.$/);
  assert.match(buildInviteBotMessage("claude", gitRoom), /Join the LetAgents repository room github\.com\/brosincode\/letagents and say hi\. You need a role on that GitHub repository\.$/);
  assert.equal(buildInviteBotMessage("other", gitRoom),
    "Connector address: https://letagents.chat/mcp (sign in with GitHub when it asks).\n"
    + "Repository room: github.com/brosincode/letagents.\n"
    + "Tell your bot to join the repository room github.com/brosincode/letagents and say hi. You need a role on that GitHub repository.");
  for (const platform of ["grok", "chatgpt", "claude", "other"] as const) {
    assert.doesNotMatch(buildInviteBotMessage(platform, gitRoom), /request access/);
  }
});

test("the section's state: closed, then the picker, then the picked bot's message; Copy writes it and says so for a moment", async () => {
  const written: string[] = [];
  const room = ref<InviteBotRoom>(adHoc);
  const invite = useInviteBot({ room, writeClipboard: async (text) => { written.push(text); }, copiedMs: 5 });
  assert.equal(invite.open.value, false);
  assert.equal(invite.platform.value, null);
  assert.equal(invite.message.value, "");
  assert.equal(await invite.copy(), false, "nothing to copy before a bot is picked");

  invite.show();
  assert.equal(invite.open.value, true);
  assert.equal(invite.platform.value, null, "opening shows the picker, not a message");

  invite.pick("grok");
  assert.equal(invite.message.value, buildInviteBotMessage("grok", adHoc));
  assert.equal(await invite.copy(), true);
  assert.deepEqual(written, [buildInviteBotMessage("grok", adHoc)]);
  assert.equal(invite.copied.value, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(invite.copied.value, false, "Copied fades");

  invite.pick("chatgpt");
  assert.equal(invite.message.value, buildInviteBotMessage("chatgpt", adHoc), "another pick changes the message");
  room.value = gitRoom;
  assert.match(invite.message.value, /repository room github\.com\/brosincode\/letagents/, "the message follows the room");

  invite.close();
  assert.equal(invite.open.value, false);
  assert.equal(invite.platform.value, null);

  const failing = useInviteBot({ room, initialPlatform: "claude", writeClipboard: async () => { throw new Error("denied"); } });
  assert.equal(failing.open.value, true, "a picked bot opens the section");
  assert.equal(await failing.copy(), false);
  assert.equal(failing.copyError.value, "The message could not be copied. Select it and copy it by hand.");
  assert.equal(failing.copied.value, false);
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
  return renderToString(createSSRApp({ render: () => h(InviteBotSection, { room: adHoc, ...props }) }));
}

test("the section renders one button until opened, then the picker, the message, Copy and the hints", async () => {
  const closed = await render({});
  assert.match(closed, /data-testid="invite-bot-open"[^>]*>\s*Invite a bot\s*</);
  assert.doesNotMatch(closed, /data-testid="invite-bot-picker"/);
  assert.doesNotMatch(closed, /data-testid="invite-bot-message"/);

  const picked = await render({ initialPlatform: "grok" });
  assert.doesNotMatch(picked, /data-testid="invite-bot-open"/, "the open button gives way to the picker");
  const buttons = [...picked.matchAll(/data-platform="([a-z]+)"[^>]*aria-pressed="(true|false)"/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(buttons, [["grok", "true"], ["chatgpt", "false"], ["claude", "false"], ["other", "false"]]);
  assert.match(picked, /data-testid="invite-bot-text">Paste this to your Grok Bot:\nConnect to LetAgents at https:\/\/letagents\.chat\/mcp and sign me in\. Then join the room PTGA-21RN-W0QP \(Sky Owl\) and say hi\. If the room asks you to request access, do it and tell me\.<\/pre>/);
  assert.match(picked, /data-testid="invite-bot-copy"[^>]*>\s*Copy\s*</);
  // Vue's SSR writes the apostrophe as an entity.
  assert.match(picked, /Send this to the bot(&#39;|')s owner\. They paste it to their bot\./);
  assert.match(picked, /data-testid="invite-bot-approve-hint"[^>]*>When the bot asks to join, approve it under Members\.</);

  const repo = await render({ room: gitRoom, initialPlatform: "other" });
  assert.match(repo, /Repository room: github\.com\/brosincode\/letagents\./);
  assert.doesNotMatch(repo, /invite-bot-approve-hint/, "a Git Room has no join request to approve");
});

test("the desktop room settings panel shows the row in General for cloud rooms, built from the room and this server's origin", () => {
  const panel = source("../src/components/desktop/content/room-shell/DesktopRoomActionPanel.vue");
  assert.match(panel, /import InviteBotSection from "(\.\.\/)+shared\/ui\/InviteBotSection\.vue";/);
  assert.match(panel, /<div v-if="cloudRoom" class="room-settings-row room-invite-bot-row" data-testid="desktop-room-invite-bot">[\s\S]*?<p class="room-settings-row-title">Invite a bot<\/p>[\s\S]*?<InviteBotSection :room="inviteBotRoom" \/>/);
  assert.match(panel, /roomId: props\.room\.identifier,\s*roomName: props\.room\.displayName,\s*gitRoom: props\.room\.gitRoom !== null,\s*connectorUrl: inviteBotConnectorUrl\(roomOrigin\.value\)/);
  // The row comes right after the room link, inside the General section.
  const general = panel.slice(panel.indexOf('data-section="general"'), panel.indexOf('<RoomMembers v-if="cloudRoom"'));
  assert.ok(general.indexOf('data-testid="desktop-room-share-card"') < general.indexOf('data-testid="desktop-room-invite-bot"'));
});

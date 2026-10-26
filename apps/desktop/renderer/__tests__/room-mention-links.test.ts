import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computed, createSSRApp, h, ssrContextKey } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

import type { DesktopParticipantSummary } from "../../electron/ipc-types";
import { renderMessageText } from "../src/components/desktop/content/desktop-chat-message/message-rendering";
import {
  buildRoomMentionDirectory,
  linkRenderedMentions,
  mentionKeyForClick,
  mentionMenuPosition,
} from "../src/domain/room-mention-links";

function participant(overrides: Partial<DesktopParticipantSummary>): DesktopParticipantSummary {
  return {
    participantKey: "p",
    kind: "agent",
    displayName: "Agent",
    actorLabel: null,
    agentKey: null,
    githubLogin: null,
    ownerLabel: null,
    ideLabel: null,
    hiddenAt: null,
    activityState: "active",
    lastSeenAt: "2026-10-26T00:00:00.000Z",
    lastRoomActivityAt: null,
    lastLiveHeartbeatAt: null,
    sourceFlags: [],
    ...overrides,
  };
}

const participants = [
  participant({ participantKey: "a1", displayName: "Harborvale", agentKey: "EmmyMay/harborvale", ownerLabel: "EmmyMay", ideLabel: "Codex", actorLabel: "Harborvale | EmmyMay's agent | Codex" }),
  participant({ participantKey: "a2", displayName: "Twin", agentKey: "EmmyMay/twin-one" }),
  participant({ participantKey: "a3", displayName: "Twin", agentKey: "shannon/twin-two" }),
  participant({ participantKey: "h1", kind: "human", displayName: "Ana", githubLogin: "ana-lee" }),
  participant({ participantKey: "h2", kind: "human", displayName: "everyone", githubLogin: "everyone" }),
];
const directory = buildRoomMentionDirectory(participants);

function render(text: string): string {
  return linkRenderedMentions(renderMessageText(text, ""), directory);
}

function mentionKeys(html: string): string[] {
  return [...html.matchAll(/data-mention-key="([^"]*)"/g)].map((match) => match[1]!);
}

describe("mention resolution", () => {
  test("an agent resolves by display name, owner/key, agent:key and last key segment", () => {
    for (const handle of ["Harborvale", "harborvale", "EmmyMay/harborvale", "agent:EmmyMay/harborvale", "agent:emmymay/harborvale"]) {
      const html = render(`hi @${handle} there`);
      assert.deepEqual(mentionKeys(html), ["agent:emmymay/harborvale"], handle);
      assert.match(html, new RegExp(`<button class="mention-token mention-link" type="button" data-mention-key="agent:emmymay/harborvale" data-mention-kind="agent" title="Open Harborvale">@${handle.replace("/", "\\/")}</button>`));
    }
  });

  test("a person resolves by GitHub login and display name", () => {
    assert.deepEqual(mentionKeys(render("@ana-lee and @Ana")), ["human:ana-lee", "human:ana-lee"]);
    assert.match(render("@Ana"), /data-mention-kind="human" title="Open Ana&#39;s profile">@Ana<\/button>/);
  });

  test("unknown names, broadcasts and ambiguous names stay plain mentions", () => {
    for (const text of ["@nobody", "@everyone", "@here", "@agents", "@Twin"]) {
      const html = render(text);
      assert.deepEqual(mentionKeys(html), [], text);
      assert.match(html, /<span class="mention-token">@/, text);
    }
    // Each of the two Twins still opens through its own key.
    assert.deepEqual(mentionKeys(render("@EmmyMay/twin-one @shannon/twin-two")), ["agent:emmymay/twin-one", "agent:shannon/twin-two"]);
  });

  test("names in inline code and fenced code are never linked", () => {
    assert.deepEqual(mentionKeys(render("run `@Harborvale go`")), []);
    assert.deepEqual(mentionKeys(render("```\n@Harborvale\n```")), []);
  });

  test("trailing punctuation stays outside the link", () => {
    const html = render("thanks @Ana. and @Harborvale: ok");
    assert.match(html, /title="Open Ana&#39;s profile">@Ana<\/button>\./);
    assert.match(html, /title="Open Harborvale">@Harborvale<\/button>:/);
  });

  test("presence agents resolve and give the inspector their live session", () => {
    const withPresence = buildRoomMentionDirectory([], [{
      displayName: "Gardenpoint", actorLabel: null, agentKey: "EmmyMay/gardenpoint", ownerLabel: "EmmyMay", ideLabel: "Claude", agentSessionId: "sess_1",
    }]);
    const target = withPresence.resolve("Gardenpoint");
    assert.equal(target?.kind, "agent");
    assert.equal(target?.kind === "agent" && target.agent.agentSessionId, "sess_1");
  });

  test("a key resolves back to the participant that opens", () => {
    const agent = directory.byKey("agent:emmymay/harborvale");
    assert.equal(agent?.kind, "agent");
    if (agent?.kind === "agent") {
      assert.equal(agent.agent.agentKey, "EmmyMay/harborvale");
      assert.equal(agent.agent.displayName, "Harborvale");
      assert.equal(agent.agent.ownerAttribution, "EmmyMay's agent");
      assert.equal(agent.agent.messageId, null);
    }
    const person = directory.byKey("human:ana-lee");
    assert.deepEqual(person?.kind === "human" && person.person, { login: "ana-lee", displayName: "Ana", avatarUrl: null });
    assert.equal(directory.byKey('agent:"><img src=x>'), null);
  });
});

describe("mention attribute safety", () => {
  test("hostile participant data is escaped in attributes and never adds markup", () => {
    const hostile = buildRoomMentionDirectory([
      participant({ displayName: `zed" onclick="alert(1)`, agentKey: `x"><img src=x onerror=alert(1)>/zed` }),
      participant({ kind: "human", displayName: `<script>alert(1)</script>`, githubLogin: "mallory" }),
    ]);
    const html = linkRenderedMentions(renderMessageText("@zed @mallory", ""), hostile);
    // The hostile text stays inside quoted, escaped attribute values: no new tags, no new attributes.
    assert.doesNotMatch(html, /<img|<script|"\s*on\w+=/i);
    assert.match(html, /data-mention-key="agent:x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;\/zed"/);
    assert.match(html, /title="Open &lt;script&gt;alert\(1\)&lt;\/script&gt;&#39;s profile">@mallory<\/button>/);
  });

  test("message text cannot forge a linked mention", () => {
    const html = render(`<button data-mention-key="human:ana-lee">x</button> <span class="mention-token">@Ana</span>`);
    assert.deepEqual(mentionKeys(html), []);
  });
});

describe("mention clicks", () => {
  function fakeTarget(key: string | null) {
    const element = { dataset: { mentionKey: key ?? undefined } };
    return { closest: (selector: string) => (selector === "[data-mention-key]" && key ? element : null) } as unknown as EventTarget;
  }

  test("a plain click or a keyboard click opens the mention", () => {
    assert.equal(mentionKeyForClick({ target: fakeTarget("human:ana-lee"), button: 0, detail: 1 }, ""), "human:ana-lee");
    assert.equal(mentionKeyForClick({ target: fakeTarget("human:ana-lee"), button: 0, detail: 0 }, "selected elsewhere"), "human:ana-lee");
  });

  test("modifier clicks, other buttons, drags that select text and other targets do not open", () => {
    const target = fakeTarget("human:ana-lee");
    for (const modifier of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) {
      assert.equal(mentionKeyForClick({ target, button: 0, detail: 1, [modifier]: true }, ""), null, modifier);
    }
    assert.equal(mentionKeyForClick({ target, button: 1, detail: 1 }, ""), null);
    assert.equal(mentionKeyForClick({ target, button: 0, detail: 1 }, "Ana and more"), null);
    assert.equal(mentionKeyForClick({ target: fakeTarget(null), button: 0, detail: 1 }, ""), null);
    assert.equal(mentionKeyForClick({ target: null, button: 0, detail: 1 }, ""), null);
  });

  test("a keyboard click opens the menu at the mention, a pointer click at the pointer", () => {
    const element = { getBoundingClientRect: () => ({ left: 40, bottom: 90 }) } as unknown as Element;
    assert.deepEqual(mentionMenuPosition({ detail: 0, clientX: 0, clientY: 0 } as MouseEvent, element), { x: 40, y: 90 });
    assert.deepEqual(mentionMenuPosition({ detail: 1, clientX: 5, clientY: 7 } as MouseEvent, element), { x: 5, y: 7 });
  });
});

describe("DesktopChatMessage mentions", () => {
  let vite: ViteDevServer;
  let DesktopChatMessage: unknown;
  // The component's copy of the module, so the injection key is the same Symbol.
  let mentionLinks: typeof import("../src/domain/room-mention-links");

  before(async () => {
    vite = await createServer({
      root: fileURLToPath(new URL("../..", import.meta.url)),
      appType: "custom",
      logLevel: "silent",
      server: { middlewareMode: true },
    });
    DesktopChatMessage = (await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/DesktopChatMessage.vue",
    )).default;
    mentionLinks = await vite.ssrLoadModule("/renderer/src/domain/room-mention-links.ts") as typeof mentionLinks;
  });

  after(async () => {
    await vite?.close();
  });

  async function renderMessage(text: string, provideDirectory: boolean): Promise<string> {
    const app = createSSRApp({
      render: () => h(DesktopChatMessage as object, {
        context: "timeline",
        message: {
          id: "msg_1", attachments: [], agentPromptKind: null, timestamp: "2026-10-26T12:00:00.000Z",
          actorLabel: null, agentIdentity: null, threadRootId: null, threadReplyToId: null, thread: null,
          replyTo: null, sender: "Ana", source: "browser", text,
        },
        threadSummary: {
          count: 0, unreadCount: 0, latest: null, latestPreview: null, latestTimestamp: null,
          participants: [], hasPartialHistory: false, loadingEarlier: false,
        },
        activeThreadRoot: false,
        highlightQuery: "",
        searchActive: false,
        testId: "room-message-msg_1",
      }),
    });
    app.provide(ssrContextKey, { modules: new Set() });
    if (provideDirectory) {
      app.provide(mentionLinks.roomMentionDirectoryKey, computed(() => mentionLinks.buildRoomMentionDirectory(participants)));
    }
    return renderToString(app);
  }

  test("a message in a room links known mentions and leaves the rest plain", async () => {
    const html = await renderMessage("@Harborvale please ask @nobody", true);
    assert.match(html, /<button class="mention-token mention-link" type="button" data-mention-key="agent:emmymay\/harborvale"/);
    assert.match(html, /<span class="mention-token">@nobody<\/span>/);
  });

  test("without a room directory mentions stay plain", async () => {
    const html = await renderMessage("@Harborvale", false);
    assert.doesNotMatch(html, /mention-link/);
    assert.match(html, /<span class="mention-token">@Harborvale<\/span>/);
  });
});

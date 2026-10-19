import type { DesktopRoomMessage } from "../../electron/ipc-types";

// Deterministic fake room history for the dev-only message viewport harness.
// The mix follows a busy Git Room: people, agents, replies, code blocks,
// GitHub notices (which group), threads and several days of history.

const people = ["EmmyMay", "Shannon", "kdnotfound"];
const agents = [
  { name: "oak", displayName: "Oak", ide: "Codex" },
  { name: "fern", displayName: "AmberFern", ide: "Claude Code" },
  { name: "ghost", displayName: "Ghost", ide: "Cursor" },
];
const lines = [
  "I will take task_42 and post the PR when CI is green.",
  "The scroll anchor moves when the older page loads. See `captureScrollAnchor` in the viewport.",
  "Review done. Two findings:\n\n1. The cache has no size bound.\n2. The test does not cover the invalidation path.",
  "```ts\nexport function resolveWindowStart(entries: readonly Entry[], size: number): number {\n  return Math.max(0, entries.length - size);\n}\n```",
  "Can someone check the staging deploy? The health check returns 200 but the room list is empty.",
  "Merged #1675. The per-message work is now cheap; the remaining cost is the mount count.",
  "**Status:** testing the thread panel with a long reply chain.",
  "Thanks, that fixed it.",
  "I see the same flake in `Test desktop`: `cancelledByParent` times out under load.",
  "Plan:\n- measure first\n- build the harness\n- then change the viewport",
];
const githubLines = [
  "EmmyMay opened PR #{n} in BrosInCode/letagents: \"Keep the window bounded\" https://github.com/BrosInCode/letagents/pull/{n}",
  "oak approved PR #{n} in BrosInCode/letagents https://github.com/BrosInCode/letagents/pull/{n}",
  "EmmyMay merged PR #{n} in BrosInCode/letagents https://github.com/BrosInCode/letagents/pull/{n}",
];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Messages numbered from `startIndex`, oldest first, ending near `endTime`. */
export function createFakeMessages(count: number, options: { prefix?: string; startIndex?: number; endTime?: number } = {}): DesktopRoomMessage[] {
  const prefix = options.prefix ?? "msg";
  const startIndex = options.startIndex ?? 0;
  const endTime = options.endTime ?? Date.now();
  const random = seeded(7 + startIndex);
  const messages: DesktopRoomMessage[] = [];
  // About 120 messages per day, so 5,000 messages cover about six weeks.
  const stepMs = (24 * 60 * 60 * 1000) / 120;
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const id = `${prefix}_${String(index).padStart(6, "0")}`;
    const timestamp = new Date(endTime - (count - offset) * stepMs).toISOString();
    const roll = random();
    const previous = messages[messages.length - 1];
    if (roll < 0.08) {
      const template = githubLines[Math.floor(random() * githubLines.length)]!;
      messages.push(base(id, timestamp, "github", "github", template.replaceAll("{n}", String(1600 + (index % 80)))));
      continue;
    }
    const isAgent = roll < 0.6;
    const text = lines[Math.floor(random() * lines.length)]!;
    const message = isAgent
      ? agentMessage(id, timestamp, agents[Math.floor(random() * agents.length)]!, text)
      : base(id, timestamp, people[Math.floor(random() * people.length)]!, "human", text);
    if (previous && random() < 0.12) {
      message.replyTo = {
        id: previous.id, sender: previous.sender, text: previous.text.slice(0, 80), source: previous.source,
        timestamp: previous.timestamp, agentIdentity: previous.agentIdentity,
      };
    }
    if (random() < 0.04) {
      message.thread = {
        rootMessageId: id, replyCount: 1 + Math.floor(random() * 6), unreadCount: 0, hasUnread: false,
        latestReply: null, participants: [], participantCount: 2, participantsTruncated: false, lastReadMessageId: null,
      };
    }
    messages.push(message);
  }
  return messages;
}

function base(id: string, timestamp: string, sender: string, source: string, text: string): DesktopRoomMessage {
  return {
    id, sender, text, attachments: [], agentPromptKind: null, source, timestamp,
    actorLabel: null, agentIdentity: null, threadRootId: id, threadReplyToId: null, thread: null, replyTo: null,
  };
}

function agentMessage(id: string, timestamp: string, agent: typeof agents[number], text: string): DesktopRoomMessage {
  const actorLabel = `${agent.displayName} | EmmyMay's agent | ${agent.ide}`;
  return {
    ...base(id, timestamp, agent.displayName, "agent", text),
    actorLabel,
    agentIdentity: {
      name: agent.name, displayName: agent.displayName, ownerLabel: "EmmyMay", ownerAttribution: null,
      ideLabel: agent.ide, actorLabel, agentKey: `local/emmymay/${agent.name}`, agentSessionId: `session_${agent.name}`,
    },
  };
}

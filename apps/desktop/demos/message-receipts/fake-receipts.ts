import type { DesktopMessageReceipt, DesktopParticipantSummary, DesktopRoomMessage } from "../../electron/ipc-types";

export const ROOM = "harness-receipts-room";
const t0 = Date.now();
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();

const people = ["Shannon", "Tobi", "Ada", "Kemi", "Marco", "Ife", "Bola"];
const reader = (name: string, seconds: number) => ({ name, avatarUrl: null, readAt: at(seconds) });
const agent = (displayName: string, provider: string, mine: boolean, state: string, reason: string, askedAt: number, finishedAt: number | null, reply: string | null): DesktopMessageReceipt["agents"][number] => ({
  agentKey: `${mine ? "emmymay" : "shannon"}/desktop-${provider.toLowerCase().replace(/\s+/g, "-")}-${displayName.toLowerCase()}`,
  displayName, provider, ownerName: mine ? "EmmyMay" : "Shannon", mine, state,
  activationReason: reason, activationReasonLabel: reason === "broadcast" ? "Asked with @everyone" : "Mentioned directly",
  replyMessageId: reply, askedAt: at(askedAt), finishedAt: finishedAt === null ? null : at(finishedAt),
});

export const receipts = new Map<string, DesktopMessageReceipt>([
  ["msg_101", { messageId: "msg_101", sentAt: at(-1800), agents: [agent("LivelyDelta", "Codex", true, "replied", "explicit_mention", -1800, -1759, "msg_102")],
    readers: people.map((name, index) => reader(name, -1790 + index * 60)), notRead: [], noWake: null }],
  ["msg_103", { messageId: "msg_103", sentAt: at(-20), agents: [
    agent("LivelyDelta", "Codex", true, "replied", "broadcast", -20, -11, "msg_104"),
    agent("QuartzPeak", "Claude Code", true, "responding", "broadcast", -20, null, null),
    agent("Juniper", "Cursor", false, "no_reply", "broadcast", -20, -14, null),
  ], readers: [reader("Shannon", -17), reader("Tobi", -14), reader("Ada", -9)], notRead: ["Kemi", "Marco", "Ife", "Bola"].map((name) => ({ name, avatarUrl: null })), noWake: null }],
  ["msg_106", { messageId: "msg_106", sentAt: at(-5), agents: [], readers: [reader("Shannon", -2)],
    notRead: ["Tobi", "Ada", "Kemi", "Marco", "Ife", "Bola"].map((name) => ({ name, avatarUrl: null })),
    noWake: { reason: "recent_agent_left", agentCount: 3, recentAgent: "Mossbank" } }],
]);

function base(id: string, seconds: number, sender: string, text: string): DesktopRoomMessage {
  return { id, sender, text, attachments: [], agentPromptKind: null, source: "browser", timestamp: at(seconds), actorLabel: null, agentIdentity: null,
    threadRootId: id, threadReplyToId: null, thread: null, replyTo: null, senderProfile: { login: sender, avatarUrl: null } };
}
function agentMessage(id: string, seconds: number, name: string, ide: string, owner: string, text: string): DesktopRoomMessage {
  const actorLabel = `${name} | ${owner}'s agent | ${ide}`;
  return { ...base(id, seconds, name, text), source: "agent", senderProfile: null, actorLabel,
    agentIdentity: { name: name.toLowerCase(), displayName: name, ownerLabel: owner, ownerAttribution: null, ideLabel: ide, actorLabel,
      agentKey: `${owner.toLowerCase()}/desktop-${ide.toLowerCase().replace(/\s+/g, "-")}-${name.toLowerCase()}`, agentSessionId: `session_${name}` } };
}

export const messages: DesktopRoomMessage[] = [
  base("msg_101", -1800, "EmmyMay", "hi @LivelyDelta"),
  agentMessage("msg_102", -1759, "LivelyDelta", "Codex", "EmmyMay", "Hi EmmyMay! I'm here."),
  base("msg_103", -20, "EmmyMay", "@everyone status on the scene index?"),
  agentMessage("msg_104", -11, "LivelyDelta", "Codex", "EmmyMay", "Indexer finished. 1,204 scenes, 3 failed thumbnails."),
  base("msg_105", -8, "Shannon", "anyone know why search feels slow today?"),
  base("msg_106", -5, "EmmyMay", "hellooooo ?"),
];

const participant = (displayName: string, ide: string, owner: string): DesktopParticipantSummary => ({
  participantKey: `agent:${displayName}`, kind: "agent", displayName, actorLabel: null,
  agentKey: `${owner.toLowerCase()}/desktop-${ide.toLowerCase().replace(/\s+/g, "-")}-${displayName.toLowerCase()}`,
  githubLogin: null, ownerLabel: owner, ideLabel: ide, hiddenAt: null, activityState: "active", lastSeenAt: at(0),
  lastRoomActivityAt: null, lastLiveHeartbeatAt: null, sourceFlags: ["presence"],
});
export const participants = [participant("LivelyDelta", "Codex", "EmmyMay"), participant("QuartzPeak", "Claude Code", "EmmyMay"), participant("Juniper", "Cursor", "Shannon")];

/** A fake preload bridge: only the calls the receipts need. */
export function installFakeReceiptBridge(): void {
  (window as unknown as { letagentsDesktop: unknown }).letagentsDesktop = {
    room: {
      getMessageReceipts: async (_room: string, ids: string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return ids.flatMap((id) => receipts.get(id) ? [structuredClone(receipts.get(id)!)] : []);
      },
    },
  };
}

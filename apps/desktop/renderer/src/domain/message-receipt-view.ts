import type { DesktopMessageNoWake, DesktopMessageReceipt } from "../../../electron/ipc-types";

type ReceiptAgent = DesktopMessageReceipt["agents"][number];

/** What a row shows. Each kind has its own icon and word, never colour alone. */
export type ReceiptRowKind = "replied" | "working" | "waiting" | "no_reply" | "attention" | "ended";

export function receiptRowKind(state: string): ReceiptRowKind {
  switch (state) {
    case "replied": return "replied";
    case "responding":
    case "retrying": return "working";
    case "queued": return "waiting";
    case "no_reply": return "no_reply";
    case "blocked":
    case "unavailable": return "attention";
    default: return "ended";
  }
}

export function receiptRowLabel(state: string): string {
  switch (state) {
    case "replied": return "Replied";
    case "responding": return "Working";
    case "retrying": return "Retrying";
    case "queued": return "Waiting";
    case "no_reply": return "No reply";
    case "blocked": return "Needs attention";
    case "unavailable": return "Unavailable";
    case "cancelled": return "Cancelled";
    default: return "Ended";
  }
}

/** The mark's tone: the one thing that still needs the sender wins. */
export type ReceiptTone = "positive" | "active" | "attention" | "nobody" | "neutral";

export interface ReceiptSummary {
  tone: ReceiptTone;
  replied: number;
  total: number;
  /** The words a screen reader hears for the mark, and the popover title. */
  title: string;
}

export function summarizeReceipt(receipt: Pick<DesktopMessageReceipt, "agents" | "noWake">): ReceiptSummary {
  const agents = receipt.agents;
  const total = agents.length;
  const kinds = agents.map((agent) => receiptRowKind(agent.state));
  const replied = kinds.filter((kind) => kind === "replied").length;
  if (!total) return { tone: "nobody", replied: 0, total: 0, title: "Nobody was woken" };
  const attention = kinds.filter((kind) => kind === "attention").length;
  const working = kinds.filter((kind) => kind === "working" || kind === "waiting").length;
  const tone: ReceiptTone = attention ? "attention" : working ? "active" : replied ? "positive" : "neutral";
  if (total === 1) {
    const [agent] = agents;
    const name = agent!.displayName;
    const kind = kinds[0];
    const title = kind === "replied" ? `${name} replied`
      : kind === "working" ? `${name} is working`
      : kind === "waiting" ? `${name} has not started yet`
      : kind === "no_reply" ? `${name} read it and did not reply`
      : kind === "attention" ? `${name} needs attention`
      : `${name} stopped`;
    return { tone, replied, total, title };
  }
  if (attention) return { tone, replied, total, title: `${attention} of ${total} need attention` };
  return { tone, replied, total, title: `${replied} of ${total} replied` };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One plain sentence on why nobody was woken. The title already says that nobody was. */
export function noWakeSentence(noWake: DesktopMessageNoWake | null, sender: "you" | string = "you"): string {
  const you = sender === "you";
  switch (noWake?.reason) {
    case "no_agents":
      return "There is no agent in this room.";
    case "ambiguous_mention": {
      const handles = noWake.handles.map((handle) => `@${handle}`).join(", ");
      return `${handles || "The mention"} matches more than one agent, so it reached none of them.`;
    }
    case "no_mention_large_room":
      return `This message has no @mention. In a room with ${plural(noWake.agentCount, "agent", "agents")}, that wakes only the agent ${you ? "you" : sender} last talked to, and there is none yet.`;
    case "recent_agent_left":
      return `This message has no @mention. In a room with ${plural(noWake.agentCount, "agent", "agents")}, that wakes only the agent ${you ? "you" : sender} last talked to, ${noWake.recentAgent}, and ${noWake.recentAgent} has left.`;
    case "routing_chose_none":
      return "This message has no @mention, and conversation routing did not pick an agent for it.";
    case "thread_no_agents":
      return "This thread reply has no @mention, and no agent is part of this thread yet.";
    default:
      return "This message did not reach an agent.";
  }
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(whole / 3600)}h ${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}m`;
}

function secondsBetween(from: string, to: string | number): number | null {
  const start = Date.parse(from);
  const end = typeof to === "number" ? to : Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null;
}

/** "Mentioned directly · in 9s", "Shannon’s agent · Asked with @everyone · 1m 04s". */
export function receiptRowDetail(agent: ReceiptAgent, sentAt: string, now: number): string {
  const parts: string[] = [];
  if (!agent.mine && agent.ownerName) parts.push(`${agent.ownerName}’s agent`);
  if (agent.activationReasonLabel) parts.push(agent.activationReasonLabel);
  const kind = receiptRowKind(agent.state);
  if (kind === "replied" && agent.finishedAt) {
    const took = secondsBetween(sentAt, agent.finishedAt);
    if (took !== null) parts.push(`in ${formatDuration(took)}`);
  } else if (kind === "working" || kind === "waiting") {
    const elapsed = secondsBetween(agent.askedAt, now);
    if (elapsed !== null) parts.push(formatDuration(elapsed));
  }
  return parts.join(" · ");
}

export function readersLabel(receipt: Pick<DesktopMessageReceipt, "readers" | "notRead">): string {
  const read = receipt.readers.length;
  if (!read) return "Nobody has read it yet";
  if (receipt.notRead && receipt.notRead.length === 0) return "Read by everyone";
  if (read === 1) return `Read by ${receipt.readers[0]!.name}`;
  return receipt.notRead ? `Read by ${read} of ${read + receipt.notRead.length}` : `Read by ${read}`;
}

/** Your own agents first, then everyone's by the time they were asked. */
export function orderReceiptAgents(agents: readonly ReceiptAgent[]): ReceiptAgent[] {
  return [...agents].sort((a, b) => Number(b.mine) - Number(a.mine) || a.askedAt.localeCompare(b.askedAt));
}

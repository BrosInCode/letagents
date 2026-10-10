import type { InjectionKey, Ref } from "vue";
import type {
  DesktopParticipantSummary,
  DesktopRoomInfo,
  DesktopSupervisorAgentConfiguration,
  DesktopSupervisorAgentHomeHarnessResult,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";

/**
 * "Your own setup" is what an agent's app loads when its owner runs it
 * themselves: their MCP servers, plugins, skills, hooks and so on. A room
 * agent starts without it. The owner can turn it on for one agent at a time,
 * and only here in the desktop app.
 */
export type AgentHomeHarnessState = NonNullable<DesktopSupervisorAgentConfiguration["homeHarness"]>;

/** Who else can reach an agent in this room, as far as the desktop can tell. */
export type AgentRoomAudience = "public" | "shared" | "private";

export const agentRoomAudienceKey: InjectionKey<Readonly<Ref<AgentRoomAudience>>> = Symbol("agentRoomAudience");

type HomeHarnessProvider = "codex" | "claude-code";

function homeHarnessProvider(provider: string): HomeHarnessProvider | null {
  const id = provider.trim().toLowerCase();
  return id === "codex" ? "codex" : id === "claude-code" || id === "claude" ? "claude-code" : null;
}

function providerLabel(provider: string): string {
  const id = provider.trim().toLowerCase();
  return id === "codex" ? "Codex"
    : id === "claude-code" || id === "claude" ? "Claude Code"
      : id === "cursor" ? "Cursor"
        : id === "open-model" ? "Open Model" : "agent app";
}

export function homeHarnessTitle(provider: string): string {
  return homeHarnessProvider(provider) ? `Use your own ${providerLabel(provider)} setup` : "Use your own setup";
}

type AudienceParticipant = Pick<DesktopParticipantSummary, "kind" | "participantKey" | "githubLogin" | "hiddenAt">
  & Partial<Pick<DesktopParticipantSummary, "ownerLabel" | "actorLabel">>;

function personName(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Whose agent this is, as the room knows it: "Owner" or "Name | Owner's agent | app". Empty when it cannot be told. */
function agentOwner(participant: AudienceParticipant): string {
  const actor = String(participant.actorLabel ?? "").split(" | ").map((part) => part.trim());
  const owner = personName(participant.ownerLabel) || (actor.length === 3 && /agent$/i.test(actor[1] ?? "") ? personName(actor[1]) : "");
  const name = owner.replace(/['’]s\s+agent$/, "").trim();
  // An agent started on this desktop without an account has no owner to compare.
  return name === "local desktop" ? "" : name;
}

/**
 * A public room is known from the room itself. Other people are known only
 * from who has been active here, so a room nobody else has posted in yet
 * reads as private. Another person's agent counts as that person: it can
 * message this agent too. `viewer` is how the signed-in account is named in
 * the room; without it, more than one person here means other people.
 */
export function agentRoomAudience(
  room: Pick<DesktopRoomInfo, "gitRoom"> | null | undefined,
  participants: readonly AudienceParticipant[],
  viewer: readonly (string | null | undefined)[] = [],
): AgentRoomAudience {
  if (room?.gitRoom?.accessMode === "public" || room?.gitRoom?.visibility === "public") return "public";
  const people = new Set<string>();
  for (const participant of participants) {
    if (participant.hiddenAt) continue;
    const person = participant.kind === "human"
      ? personName(participant.githubLogin) || participant.participantKey
      : agentOwner(participant);
    if (person) people.add(person);
  }
  const mine = new Set(viewer.map(personName).filter(Boolean));
  if (mine.size) return [...people].some((person) => !mine.has(person)) ? "shared" : "private";
  return people.size > 1 ? "shared" : "private";
}

/** What the switch lets the agent use. True for the provider and the access level named. */
export function homeHarnessDescription(provider: string, permissionProfileId: string | null = null): string {
  const kind = homeHarnessProvider(provider);
  if (kind === "codex") {
    return "Lets this agent use your own Codex setup: your MCP servers, plugins, app connectors, skills, hooks, memories, and browser or computer control. Those tools act as you. Servers and hooks that a project adds stay off, and the agent will not start in a project that changes your servers or brings its own Codex settings or command rules.";
  }
  if (kind === "claude-code") {
    // A Read-only agent has no tool that runs a skill. Claude's default access level is Read-only.
    return permissionProfileId === "read_only" || permissionProfileId === null
      ? "Lets this agent use your own Claude Code setup: your MCP servers, plugins' servers, hooks, instructions and permission rules. Those tools act as you. With Read-only it cannot run your skills."
      : "Lets this agent use your own Claude Code setup: your MCP servers, plugins, skills, commands, hooks, instructions and permission rules. Those tools act as you.";
  }
  return "";
}

/**
 * Whether one of the owner's tools asks before it runs. This depends on the
 * agent's saved access level, and is what each provider was seen to do.
 */
export function homeHarnessApprovalNote(provider: string, permissionProfileId: string | null): string {
  const kind = homeHarnessProvider(provider);
  if (kind === "codex") {
    if (permissionProfileId === "ask_before_write") {
      // "Read-only" is a label a server puts on its own tool. Nothing checks it.
      return "With Ask before writes, you approve each of those tools before it runs. Two kinds run without asking: tools your own Codex settings already approve, and tools their own server labels read-only, which nothing checks.";
    }
    if (permissionProfileId === "auto_review") {
      return "With Auto, Codex decides whether each of those tools runs. You are not asked.";
    }
    if (permissionProfileId === "read_only") {
      // Nobody can be asked, so Codex refuses the MCP tools it would otherwise ask about. Only MCP tools were tried at this level.
      return "With Read-only, nothing asks you for an approval. Your MCP tools run only when your own Codex settings already approve them or their own server labels them read-only, which nothing checks. Codex refuses your other MCP tools. This level puts no limit of its own on your hooks, plugins and other tools.";
    }
    return "With Full access, those tools run without asking you.";
  }
  if (kind === "claude-code") {
    const projectStaysOut = "A project's own servers and settings are not loaded.";
    if (permissionProfileId === "ask_before_write") {
      return `With Ask before writes, you approve each of those tools before it runs, unless your own Claude Code rules already allow it. ${projectStaysOut}`;
    }
    if (permissionProfileId === "auto_review") {
      return `With Auto, Claude decides whether each of those tools runs, and asks you only when it will not decide. Your own Claude Code rules can allow a tool first. ${projectStaysOut}`;
    }
    if (permissionProfileId === "full_access") {
      return "With Full access, those tools run without asking you. While this is on, the project's own Claude settings, hooks, skills, commands and MCP servers are not loaded. Its CLAUDE.md still is.";
    }
    return `With Read-only, those tools run only where your own Claude Code rules allow them. Nothing asks you. ${projectStaysOut}`;
  }
  return "";
}

/** Shown where the agent can be moved to another room: the switch travels with it, and the new room's people can use it. */
export function homeHarnessMoveNote(provider: string): string {
  return `This agent keeps using your own ${homeHarnessProvider(provider) ? providerLabel(provider) : "agent app"} setup after a move. Anyone who can message it in the room you move it to can ask it to use your tools. Turn that off first if you do not want it there.`;
}

/**
 * A tool the owner chose to always allow is tied to the agent's access
 * settings, and this switch is one of them. Null when there is none saved.
 */
export function homeHarnessSavedRulesNote(savedRules: number): string | null {
  return savedRules > 0
    ? "Changing this pauses the tools under Always allowed. They stay listed but stop applying, so the agent asks again. Changing it back restores them."
    : null;
}

/** A tool that needs an answer nobody can give here is turned down, so the agent never waits on it. */
export function homeHarnessLimitNote(provider: string): string {
  const kind = homeHarnessProvider(provider);
  if (kind === "codex") return "A tool that needs you to type an answer or sign in is declined.";
  if (kind === "claude-code") return "A tool that needs you to type an answer is declined, and so is anything a skill's helper agent needs approved.";
  return "";
}

export function homeHarnessRoomNote(audience: AgentRoomAudience): string {
  if (audience === "public") return "This room is public. Anyone who can post here can ask this agent to use your tools.";
  if (audience === "shared") return "Other people are in this room. Any of them can ask this agent to use your tools.";
  return "Anyone who can message this agent in the room can ask it to use them.";
}

/** When a change reaches the agent. A process that is already running keeps what it started with. */
export function homeHarnessTimingNote(state: Pick<AgentHomeHarnessState, "enabled" | "pending">): string {
  if (state.pending && state.enabled) return "This agent has not restarted since you turned this on. It gets your setup the next time it starts.";
  if (state.pending) return "If this agent is still running, it keeps your setup until it restarts.";
  return "Turning this on takes effect the next time the agent starts. Turning it off restarts the agent straight away if it is idle.";
}

/** What happened to the running agent when the switch was turned off. Null when there is nothing to say. */
export function homeHarnessRestartNote(restart: DesktopSupervisorAgentHomeHarnessResult["restart"]): { text: string; warning: boolean } | null {
  if (restart === "restarting") return { text: "Restarting this agent now so it stops using your setup.", warning: false };
  if (restart === "busy") return { text: "This agent is working, so it was not restarted yet. It keeps your setup until this turn ends, then restarts before it takes another.", warning: true };
  if (restart === "not_restarted") return { text: "This agent was not restarted. If it is running, it keeps your setup until it restarts.", warning: true };
  return null;
}

/** Why there is no switch, in one line. Null when the agent can use the owner's setup. */
export function homeHarnessUnavailableReason(state: Pick<AgentHomeHarnessState, "availability">, provider: string): string | null {
  if (state.availability === "available") return null;
  if (state.availability === "rental") return "A rented agent works for someone else, so it never uses your own setup.";
  if (state.availability === "polling") return "Not available for this agent: it fetches its own messages, so LetAgents can't reliably switch your setup off again.";
  const id = provider.trim().toLowerCase();
  if (id === "cursor") return "Cursor agents run in a sealed copy of Cursor, so they cannot load your own Cursor setup.";
  if (id === "open-model") return "Open Model agents run LetAgents' own copy of OpenCode, which has no setup of yours to load.";
  return "This agent app has no setup of yours to load.";
}

/**
 * A short label for lists and headers. It says what the running agent has,
 * not only what is saved: a change reaches an agent when it restarts.
 */
export function homeHarnessBadge(provider: string, state: NonNullable<DesktopSupervisorManifestEntry["homeHarness"]>): { label: string; title: string } {
  const setup = `your own ${providerLabel(provider)} setup`;
  // The label stays short so the agent's name keeps its room; the title says the rest.
  if (state === "after_restart") {
    return { label: "Setup pending", title: `This agent is set to use ${setup}. It gets it the next time it starts.` };
  }
  if (state === "until_restart") {
    return { label: "Setup ending", title: `You turned this off, but this agent is still running with ${setup}. It loses it when it restarts.` };
  }
  return { label: "Your setup", title: `This agent uses ${setup}.` };
}

/**
 * Why a start was refused for an agent that uses its owner's setup, as the
 * launch said it: what the project or the setup did, and the ways out. The
 * background service files it under a scheduler failure, which says nothing
 * to the owner, so the reason is shown on its own. Null for any other failure.
 */
export function ownerSetupRefusalReason(lastError: string | null | undefined): string | null {
  const detail = lastError?.trim() ?? "";
  if (!/\bwith your own setup\b/i.test(detail)) return null;
  return detail.replace(/^convergence scheduler failure:\s*/i, "").trim() || null;
}

/**
 * What a start that ran out of time says about the owner's own setup: the
 * servers Claude named as not started, or that something of the owner's may
 * be holding it up. Empty for a start that did not have the owner's setup.
 */
export function ownerSetupStartHint(detail: string): string {
  const named = [...detail.matchAll(/Your MCP server "[^"]*" [^.]*\./g)].map((match) => match[0]);
  if (named.length) return named.join(" ");
  return /This agent starts with your own Claude Code setup/.test(detail)
    ? "One of your own MCP servers or hooks may be holding the start up."
    : "";
}

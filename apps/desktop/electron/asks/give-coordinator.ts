import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { DesktopAgentProviderId } from "../ipc-types.js";
import type { DesktopSupervisorManifestEntry } from "../ipc-types/agents.js";
import type { DesktopAgentAsk, DesktopGiveAgentInput } from "../ipc-types/asks.js";
import type { ProviderUsage } from "../../shared/provider-usage.js";
import { getOrCreateDesktopHostId } from "../main/agents/state.js";
import { listGuestSafePermissionProfiles } from "../main/agents/rental-permission-profiles.js";
import { runDesktopAgentProviderPreflight } from "../main/agents/providers.js";
import { getOrCreateDesktopSupervisorAgentIdentity } from "../main/supervisor-grant.js";
import { supervisorDaemonClient, type SupervisorDaemonClient } from "../main/supervisor-daemon.js";
import { supervisorGrantCoordinator, type SupervisorGrantCoordinator } from "../main/supervisor-grant-coordinator.js";
import { rentalProviderInstallationId } from "../rental/provider-host-manager.js";
import { askApi, AskGiveError, type AskApi } from "./api.js";

const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const WATCH_MS = 60_000;
const FINISHED = new Set(["ended", "expired", "cancelled", "open"]);

/**
 * A given agent runs as a guest: its entry id carries the `supervised_rental_`
 * prefix on purpose, so every guest safeguard the daemon and adapters already
 * apply to rentals (credential isolation, a scratch workspace, guest-safe
 * permission profiles only, no home setup, no automatic approvals) applies
 * here too, with no second code path to keep in sync.
 */
export function giftEntryId(askId: string): string {
  return `supervised_rental_ask_${createHash("sha256").update(askId).digest("hex").slice(0, 32)}`;
}

/** Standing instructions for a given agent: what it is, its limits, and to wait to be asked. */
export function giftCharter(asker: string): string {
  return [
    `Someone added you to ${asker}'s room to help them. LetAgents has already introduced you, so don't introduce yourself again.`,
    "Wait until someone in the room addresses you, then help with what they ask.",
    "If the room has a repo, its code is with LetAgents, not in your folder: use ask_list_files, ask_read_file and ask_search to read it, and ask_propose_change to change it. The person who asked reviews every change.",
    "You run in a locked folder on another person's computer: you can't use Docker, apps, or files outside your folder. If a task needs those, say so plainly instead of retrying.",
  ].join("\n");
}

/** Claude as a guest: no built-in tools at all, only the room's LetAgents tools. */
export const GUEST_CLAUDE_LAUNCH_POLICY = Object.freeze({
  permissionMode: "dontAsk", dangerouslySkipPermissions: false, tools: [] as string[],
  allowedTools: ["mcp__letagents__*"], settingSources: "",
});

/** The permission profile a given agent runs with, or null when this provider can't be given safely yet. */
export function giftPermissionProfile(providerId: string): string | null {
  if (!["codex", "claude-code", "cursor", "open-model"].includes(providerId)) return null;
  return listGuestSafePermissionProfiles(providerId as DesktopAgentProviderId)[0]?.id ?? null;
}

type Gift = {
  token: string; askId: string; entryId: string; roomId: string; amountPercent: number;
  /** Limit window being counted, and how much of it this gift has used so far (G16: survives resets). */
  windowId: string | null; lastUsedPercent: number | null; consumedPercent: number;
};
type Journal = { version: 1; gifts: Record<string, Gift> };

function journalPath(): string {
  return process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH?.trim() || join(homedir(), ".letagents", "desktop", "agent-gifts.json");
}

async function readJournal(): Promise<Journal> {
  try {
    const parsed = JSON.parse(await readFile(journalPath(), "utf8")) as Partial<Journal>;
    return parsed?.version === 1 && parsed.gifts && typeof parsed.gifts === "object" ? { version: 1, gifts: parsed.gifts } : { version: 1, gifts: {} };
  } catch { return { version: 1, gifts: {} }; }
}

let journalTail: Promise<unknown> = Promise.resolve();
function updateJournal(change: (journal: Journal) => void): Promise<void> {
  const next = journalTail.catch(() => undefined).then(async () => {
    const journal = await readJournal();
    change(journal);
    const path = journalPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  });
  journalTail = next;
  return next;
}

/** The window a gift counts against: the longest one the provider reports (weekly before 5-hour). */
export function mainWindow(usage: ProviderUsage | null | undefined, preferred: string | null) {
  const windows = usage?.account.state === "unavailable" ? [] : usage?.account.windows ?? [];
  if (preferred) { const kept = windows.find(window => window.id === preferred); if (kept) return kept; }
  const rank = (label: string) => /week/i.test(label) ? 3 : /day|month/i.test(label) ? 2 : 1;
  return [...windows].sort((a, b) => rank(b.label) - rank(a.label))[0] ?? null;
}

/** Pure step of the amount counter, exported for tests. */
export function countUsage(gift: Pick<Gift, "windowId" | "lastUsedPercent" | "consumedPercent">, window: { id: string; usedPercent: number }) {
  if (gift.windowId !== window.id || gift.lastUsedPercent === null) {
    return { windowId: window.id, lastUsedPercent: window.usedPercent, consumedPercent: gift.consumedPercent };
  }
  // A drop means the window reset: start counting again from the new reading, keep what was used.
  const delta = window.usedPercent >= gift.lastUsedPercent ? window.usedPercent - gift.lastUsedPercent : window.usedPercent;
  return { windowId: window.id, lastUsedPercent: window.usedPercent, consumedPercent: gift.consumedPercent + delta };
}

export class AskGiveCoordinator {
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watching: Promise<void> | null = null;

  constructor(
    private readonly api: AskApi = askApi,
    private readonly daemon: SupervisorDaemonClient = supervisorDaemonClient,
    private readonly grants: SupervisorGrantCoordinator = supervisorGrantCoordinator,
    private readonly hostId: () => string = getOrCreateDesktopHostId,
    private readonly resolveIdentity: typeof getOrCreateDesktopSupervisorAgentIdentity = getOrCreateDesktopSupervisorAgentIdentity,
    private readonly preflight: typeof runDesktopAgentProviderPreflight = runDesktopAgentProviderPreflight,
  ) {}

  /** One tap on "Add": start a guest agent in the asker's room. Any failure gives the link back. */
  async give(input: DesktopGiveAgentInput): Promise<DesktopAgentAsk> {
    const profile = giftPermissionProfile(input.providerId);
    if (!profile) throw new AskGiveError("This app can't be given safely yet. Choose another model.");
    if (!Number.isInteger(input.amountPercent) || input.amountPercent < 1 || input.amountPercent > 100) {
      throw new AskGiveError("Choose how much to give, from 1% to 100%.");
    }
    const readiness = await this.preflight(input.providerId as DesktopAgentProviderId, {
      repoRootPath: process.cwd(), model: input.model, permissionProfileId: profile,
    }).catch(() => null);
    if (!readiness?.canStart) throw new AskGiveError(readiness?.detail || readiness?.message || "Set up this app first, then try again.");

    const claimed = await this.api.claim(input.token);
    const entryId = giftEntryId(claimed.id);
    let prepared: DesktopSupervisorManifestEntry | null = null;
    try {
      await this.daemon.ensureRunning().catch(() => { throw new AskGiveError("Your Mac couldn't start this agent. The request is still open for others."); });
      const displayName = `${claimed.asker}'s helper`;
      const agentKey = await this.resolveIdentity({ entryId, displayName, providerId: input.providerId });
      const hostId = this.hostId();
      const installationId = rentalProviderInstallationId(hostId);
      const authority = await this.api.launchAuthority(input.token, {
        host_id: hostId, installation_id: installationId, agent_key: agentKey, provider_id: input.providerId,
        model: input.model, model_label: input.modelLabel, amount_percent: input.amountPercent,
      });
      const roomId = String(authority.room_id ?? "");
      const grant = (authority.grant ?? {}) as Record<string, unknown>;
      const token = String(grant.supervisor_grant ?? ""); const grantId = String(grant.grant_id ?? ""); const expiresAt = String(grant.expires_at ?? "");
      if (!roomId || !token || !grantId || !expiresAt) throw new AskGiveError("LetAgents didn't confirm the agent's access. Try again.");
      const { entry } = await this.grants.createRentalPausedAndInstall({
        creationRequestId: entryId.slice("supervised_".length), roomIdentifier: roomId, displayName,
        providerId: input.providerId as DesktopAgentProviderId, model: input.model, charter: giftCharter(claimed.asker),
        permissionProfileId: profile, repoRootPath: null, agentKey,
        ...(input.providerId === "claude-code" ? { launchPolicy: GUEST_CLAUDE_LAUNCH_POLICY } : {}),
        preparedGrant: {
          metadata: { grantId, hostId, installationId, allowedRoomIds: [roomId], allowedAgentKeys: [agentKey],
            generation: Number(grant.current_generation ?? grant.generation ?? 1), expiresAt },
          authority: null, token,
        },
      });
      prepared = entry;
      if (!await this.daemon.compareAndSetDesiredState(entry.id, "paused", "running")) {
        throw new AskGiveError("Your Mac couldn't start this agent. The request is still open for others.");
      }
      const ready = await this.waitUntilReady(entry.id);
      const usage = await this.readUsage(ready.id, roomId);
      const window = mainWindow(usage, null);
      if (window && 100 - window.usedPercent < input.amountPercent) {
        throw new AskGiveError(`You have ${Math.max(0, Math.round(100 - window.usedPercent))}% of your ${window.label.toLowerCase()} limit left. Give less or try later.`);
      }
      const joined = await this.api.joined(input.token, ready.agentSessionId!);
      await updateJournal(journal => {
        journal.gifts[input.token] = { token: input.token, askId: claimed.id, entryId: ready.id, roomId, amountPercent: input.amountPercent,
          windowId: window?.id ?? null, lastUsedPercent: window?.usedPercent ?? null, consumedPercent: 0 };
      });
      this.startWatching();
      return joined;
    } catch (error) {
      if (prepared) await this.stopAndPurge(prepared.id).catch(() => undefined);
      await this.api.release(input.token, false).catch(() => undefined);
      throw error instanceof AskGiveError ? error : new AskGiveError("Your Mac couldn't start this agent. The request is still open for others.");
    }
  }

  /** "Can't right now": tell the asker and leave the link open. */
  async cantHelp(token: string): Promise<void> {
    await this.api.claim(token).catch(() => undefined);
    await this.api.release(token, true);
  }

  startWatching(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => void this.watchOnce(), WATCH_MS);
    this.watchTimer.unref?.();
    void this.watchOnce();
  }

  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /** Count each running gift against its amount; end it when used up or when the asker ended it. */
  watchOnce(): Promise<void> {
    if (this.watching) return this.watching;
    this.watching = (async () => {
      const journal = await readJournal();
      for (const gift of Object.values(journal.gifts)) {
        try { await this.checkGift(gift); } catch (error) { console.warn("[agent gifts] check failed", gift.askId, error); }
      }
      if (!Object.keys((await readJournal()).gifts).length) this.stopWatching();
    })().finally(() => { this.watching = null; });
    return this.watching;
  }

  private async checkGift(gift: Gift): Promise<void> {
    const preview = await this.api.preview(gift.token).catch(() => null);
    if (preview && FINISHED.has(preview.ask.state)) return this.finish(gift);
    const usage = await this.readUsage(gift.entryId, gift.roomId);
    if (usage?.account.windows.some(window => window.usedPercent >= 100)) {
      await this.api.end(gift.token, "provider_limit").catch(() => undefined);
      return this.finish(gift);
    }
    const window = mainWindow(usage, gift.windowId);
    if (!window) return;
    const counted = countUsage(gift, window);
    if (counted.consumedPercent >= gift.amountPercent) {
      await this.api.end(gift.token, "amount_used").catch(() => undefined);
      return this.finish(gift);
    }
    await updateJournal(journal => { if (journal.gifts[gift.token]) journal.gifts[gift.token] = { ...gift, ...counted }; });
  }

  private async finish(gift: Gift): Promise<void> {
    await this.stopAndPurge(gift.entryId).catch(() => undefined);
    await updateJournal(journal => { delete journal.gifts[gift.token]; });
  }

  private async readUsage(entryId: string, roomId: string): Promise<ProviderUsage | null> {
    const detail = await this.daemon.getAgentInspectorDetail({ entryId, roomId }).catch(() => null);
    return detail?.usage ?? null;
  }

  private async waitUntilReady(entryId: string): Promise<DesktopSupervisorManifestEntry> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const entry = (await this.daemon.list(null)).find(candidate => candidate.id === entryId);
      if (entry?.observedState === "failed" || entry?.condition === "quarantined") break;
      if (entry && entry.desiredState === "running" && entry.agentSessionId && entry.agentSessionBindingState === "active" && entry.readyReachedAt) return entry;
      await new Promise<void>(resolve => setTimeout(resolve, READY_POLL_MS));
    }
    throw new AskGiveError("Your Mac couldn't start this agent. The request is still open for others.");
  }

  private async stopAndPurge(entryId: string): Promise<void> {
    await this.daemon.setDesiredState(entryId, "stopped").catch(() => undefined);
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      const entry = (await this.daemon.list(null)).find(candidate => candidate.id === entryId);
      if (!entry || ["stopped", "absent", "failed"].includes(String(entry.observedState))) break;
      await new Promise<void>(resolve => setTimeout(resolve, READY_POLL_MS));
    }
    const generation = (await this.daemon.ensureRunning()).generation;
    const prepared = await this.daemon.purgeAgent(entryId, generation);
    if (prepared.outcome !== "revocation_required") return;
    if (prepared.revocationKind === "worker_session" && prepared.agentSessionId) {
      await this.grants.revokeEntryForPurge(entryId, prepared.agentSessionId);
      await this.daemon.purgeAgent(entryId, generation, prepared.agentSessionId);
      return;
    }
    await this.grants.revokeEntryForPurgeWithoutWorkerSession(entryId);
    await this.daemon.purgeAgent(entryId, generation, null, true);
  }
}

export const askGiveCoordinator = new AskGiveCoordinator();

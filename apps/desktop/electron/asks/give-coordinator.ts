import { createHash, randomUUID } from "node:crypto";
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
// Often enough that a busy turn can't run far past the amount between checks. Claude and
// Cursor readings arrive as they change; Codex refreshes its own about every 30s.
const WATCH_MS = 15_000;
const FINISHED = new Set(["ended", "expired", "cancelled", "open"]);
/** Removal tries (one per watch tick) before a gift the daemon will not remove is left to the owner. */
export const GIVE_UP_PURGE_TRIES = 40;

/**
 * A given agent runs as a guest: its entry id carries the `supervised_rental_`
 * prefix on purpose, so every guest safeguard the daemon and adapters already
 * apply to rentals (credential isolation, a scratch workspace, guest-safe
 * permission profiles only, no home setup, no automatic approvals) applies
 * here too, with no second code path to keep in sync.
 *
 * Each attempt gets its own id. The daemon binds a creation id to the first
 * parameters it saw and keeps a tombstone once that entry is purged, so an id
 * made from the ask alone would refuse every later try with another app, and
 * every try at all after a failed one was cleaned up.
 */
export function giftEntryId(askId: string, attempt: string): string {
  return `supervised_rental_ask_${createHash("sha256").update(`${askId}\n${attempt}`).digest("hex").slice(0, 32)}`;
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
  /** Gifts from the same app share one usage limit. Older journals lack these. */
  providerId?: string;
  model?: string | null;
  /** Limit window being counted, and how much of it this gift has used so far (G16: survives resets). */
  windowId: string | null; lastUsedPercent: number | null; consumedPercent: number;
  /** Paused because the app quit; the next app start resumes it (D40: offline, then back). */
  pausedForQuit?: boolean;
  /** A substitute stays paused until the asker accepts it. */
  waitingForAsker?: boolean;
  /** Written before the daemon creates the agent, so an attempt that dies with the app leaves nothing unwatched. */
  starting?: boolean;
  /** Only the local agent is left to remove; each check tries again until it is gone, without asking the server. */
  purgePending?: boolean;
  purgeTries?: number;
};
/** Gifts by entry id: a link given again after a failed try has two rows, so the failed agent is still removed. */
type Journal = { version: 1; gifts: Record<string, Gift> };

function journalPath(): string {
  return process.env.LETAGENTS_AGENT_GIFT_JOURNAL_PATH?.trim() || join(homedir(), ".letagents", "desktop", "agent-gifts.json");
}

async function readJournal(): Promise<Journal> {
  try {
    const parsed = JSON.parse(await readFile(journalPath(), "utf8")) as Partial<Journal>;
    if (parsed?.version !== 1 || !parsed.gifts || typeof parsed.gifts !== "object") return { version: 1, gifts: {} };
    // Older journals were keyed by link token; every row is keyed by its entry id from here on.
    const gifts = Object.values(parsed.gifts).filter(gift => gift && typeof gift.entryId === "string" && gift.entryId);
    return { version: 1, gifts: Object.fromEntries(gifts.map(gift => [gift.entryId, gift])) };
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

/**
 * Tests only: empty the journal through the same queue as every other write,
 * so an update already queued by a still-running watcher cannot write an
 * older journal back over the reset.
 */
export function resetAgentGiftJournalForTests(): Promise<void> {
  return updateJournal(journal => { journal.gifts = {}; });
}

/** The window a gift counts against: the longest one the provider reports (weekly before 5-hour). */
/**
 * The limits this model runs against. Another model's own limit doesn't apply
 * (Claude's Opus or Sonnet weekly, Codex's other buckets), nor does Claude's
 * extra usage, which is spent only after the plan. Older journals know no model: all apply.
 */
export function modelLimits(usage: ProviderUsage | null | undefined, providerId?: string, model?: string | null) {
  const windows = usage?.account.state === "unavailable" ? [] : usage?.account.windows ?? [];
  const name = (model ?? "").toLowerCase();
  if (providerId === "claude-code") {
    return windows.filter(limit => limit.id === "five_hour" || limit.id === "seven_day"
      || (limit.id === "seven_day_opus" && name.includes("opus")) || (limit.id === "seven_day_sonnet" && name.includes("sonnet")));
  }
  if (providerId === "codex") {
    const main = windows.filter(limit => limit.id.startsWith("codex:"));
    return main.length ? main : windows;
  }
  return windows;
}

/** A limit that would stop this agent now. Cursor's included usage stops nothing while on-demand budget is left. */
export function usedUpLimit(usage: ProviderUsage | null | undefined, providerId?: string, model?: string | null) {
  const limits = modelLimits(usage, providerId, model);
  const onDemand = providerId === "cursor" ? limits.find(limit => limit.id === "cursor-on-demand") : undefined;
  return limits.find(limit => limit.usedPercent >= 100 && !(onDemand && limit.id === "cursor-plan" && onDemand.usedPercent < 100)) ?? null;
}

export function mainWindow(usage: ProviderUsage | null | undefined, preferred: string | null, providerId?: string, model?: string | null) {
  const windows = modelLimits(usage, providerId, model);
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
  /** Gifts this process is giving right now: their journal rows are not orphans. */
  private readonly giving = new Set<string>();

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
    // Only a model from the current list: an old or edited one would run something the asker didn't pick.
    const known = await this.api.models().catch(() => null);
    if (!known) throw new AskGiveError("Couldn't load the model list. Check your connection and try again.");
    if (!known.some(model => model.providerId === input.providerId && (model.model ?? null) === (input.model ?? null))) {
      throw new AskGiveError("That model isn't on the list anymore. Choose another model.");
    }
    const readiness = await this.preflight(input.providerId as DesktopAgentProviderId, {
      repoRootPath: process.cwd(), model: input.model, permissionProfileId: profile,
    }).catch(() => null);
    if (!readiness?.canStart) throw new AskGiveError(readiness?.detail || readiness?.message || "Set up this app first, then try again.");

    const claimed = await this.api.claim(input.token);
    const entryId = giftEntryId(claimed.id, randomUUID());
    let prepared: DesktopSupervisorManifestEntry | null = null;
    let creating = false;
    this.giving.add(input.token);
    try {
      await this.daemon.ensureRunning().catch(() => { throw new AskGiveError("This computer couldn't start this agent. The request is still open for others."); });
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
      // Recorded before the daemon has the agent: if this attempt dies here, the watcher removes what it left.
      await updateJournal(journal => {
        journal.gifts[entryId] = { token: input.token, askId: claimed.id, entryId, roomId, providerId: input.providerId, model: input.model, amountPercent: input.amountPercent,
          windowId: null, lastUsedPercent: null, consumedPercent: 0, starting: true };
      });
      creating = true;
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
      // The agent exists now; a crash from here on still leaves it watched.
      await updateJournal(journal => {
        delete journal.gifts[entryId];
        journal.gifts[entry.id] = { token: input.token, askId: claimed.id, entryId: entry.id, roomId, providerId: input.providerId, model: input.model, amountPercent: input.amountPercent,
          windowId: null, lastUsedPercent: null, consumedPercent: 0 };
      });
      if (!await this.daemon.compareAndSetDesiredState(entry.id, "paused", "running")) {
        throw new AskGiveError("This computer couldn't start this agent. The request is still open for others.");
      }
      const ready = await this.waitUntilReady(entry.id);
      const usage = await this.readUsage(ready.id, roomId);
      // Any limit already used up (a 5-hour one, say) means the agent couldn't do anything.
      const usedUp = usedUpLimit(usage, input.providerId, input.model);
      if (usedUp) throw new AskGiveError(`Your usage limit (${usedUp.label}) is used up. Try again after it resets.`);
      const window = mainWindow(usage, null, input.providerId, input.model);
      // What this app's other gifts may still use is already promised, so it isn't left to give.
      const promised = Object.values((await readJournal()).gifts)
        .filter(gift => gift.entryId !== ready.id && gift.providerId === input.providerId && !gift.purgePending)
        .reduce((total, gift) => total + Math.max(0, gift.amountPercent - gift.consumedPercent), 0);
      const left = window ? 100 - window.usedPercent - promised : 100;
      if (window && left < input.amountPercent) {
        throw new AskGiveError(`You have ${Math.max(0, Math.round(left))}% of your ${window.label.toLowerCase()} limit left${promised ? " after your other gifts" : ""}. Give less or try later.`);
      }
      const joined = await this.api.joined(input.token, ready.agentSessionId!);
      // A different model than asked for joins on hold: it does nothing until the asker accepts it.
      const waitingForAsker = joined.state === "on_hold"
        && Boolean(await this.daemon.compareAndSetDesiredState(ready.id, "running", "paused").catch(() => false));
      await updateJournal(journal => {
        const gift = journal.gifts[ready.id];
        if (gift) journal.gifts[ready.id] = { ...gift, windowId: window?.id ?? null, lastUsedPercent: window?.usedPercent ?? null, waitingForAsker };
      });
      this.startWatching();
      return joined;
    } catch (error) {
      // The daemon may hold the agent once creation began, even when the call itself failed.
      const stopped = creating
        ? await this.stopAndPurge(prepared?.id ?? entryId).then(() => true, (reason: unknown) => {
          console.warn("[agent gifts] stop failed", claimed.id, reason);
          return false;
        })
        : true;
      // Forget it only once it is really gone; otherwise the watcher keeps trying.
      const key = prepared?.id ?? entryId;
      if (stopped) await updateJournal(journal => { delete journal.gifts[entryId]; delete journal.gifts[key]; });
      else {
        await updateJournal(journal => { const gift = journal.gifts[key]; if (gift) { gift.starting = false; gift.purgePending = true; gift.purgeTries = 1; } });
        this.startWatching();
      }
      await this.api.release(input.token, false).catch(() => undefined);
      throw error instanceof AskGiveError ? error : new AskGiveError("This computer couldn't start this agent. The request is still open for others.");
    } finally {
      this.giving.delete(input.token);
    }
  }

  /** "Can't right now": tell the asker and leave the link open. A link someone else holds can't be answered. */
  async cantHelp(token: string): Promise<void> {
    await this.api.claim(token);
    const released = await this.api.release(token, true);
    if (released.ok !== true) throw new AskGiveError("This request has already changed. Open the link again to see where it is.");
  }

  startWatching(): void {
    if (this.watchTimer) return;
    void this.resumeAfterQuit();
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
    // Its gift already failed and the link was given back: only the local agent is left to remove.
    if (gift.purgePending) return this.finish(gift);
    // Written by an attempt that died with the app: whatever it left in the daemon goes.
    if (gift.starting) return this.giving.has(gift.token) ? undefined : this.finish(gift);
    const preview = await this.api.preview(gift.token).catch(() => null);
    // Finished, or no longer this giver's: a declined substitute's link can reopen and be given by someone else.
    if (preview && (FINISHED.has(preview.ask.state) || preview.ask.is_giver === false)) return this.finish(gift);
    if (gift.waitingForAsker && preview?.ask.state === "active") {
      if (await this.daemon.compareAndSetDesiredState(gift.entryId, "paused", "running").catch(() => false)) {
        await updateJournal(journal => { const current = journal.gifts[gift.entryId]; if (current) current.waitingForAsker = false; });
      }
      return;
    }
    const usage = await this.readUsage(gift.entryId, gift.roomId);
    if (usedUpLimit(usage, gift.providerId, gift.model)) {
      await this.api.end(gift.token, "provider_limit").catch(() => undefined);
      return this.finish(gift);
    }
    const window = mainWindow(usage, gift.windowId, gift.providerId, gift.model);
    if (!window) return;
    const counted = countUsage(gift, window);
    if (counted.consumedPercent >= gift.amountPercent) {
      await this.api.end(gift.token, "amount_used").catch(() => undefined);
      return this.finish(gift);
    }
    await updateJournal(journal => { const current = journal.gifts[gift.entryId]; if (current) journal.gifts[gift.entryId] = { ...current, ...counted }; });
  }

  /**
   * Stop and forget a gift. A refused removal keeps it in the journal, so the
   * next check tries again; after enough refusals the agent is left in the
   * agent list for the owner to remove, so the other gifts' checks go on.
   */
  private async finish(gift: Gift): Promise<void> {
    try {
      await this.stopAndPurge(gift.entryId);
    } catch (error) {
      const purgeTries = (gift.purgeTries ?? 0) + 1;
      if (purgeTries < GIVE_UP_PURGE_TRIES) {
        await updateJournal(journal => { const current = journal.gifts[gift.entryId]; if (current) Object.assign(current, { starting: false, purgePending: true, purgeTries }); });
        throw error;
      }
      console.warn("[agent gifts] could not remove", gift.entryId, `after ${purgeTries} tries; it stays in the agent list to remove by hand`, error);
    }
    await updateJournal(journal => { delete journal.gifts[gift.entryId]; });
  }

  /**
   * The app is quitting: the watch stops with it, so running gifts are paused
   * (the room sees them go offline) rather than left running unwatched.
   */
  async pauseForQuit(): Promise<void> {
    this.stopWatching();
    const journal = await readJournal();
    for (const gift of Object.values(journal.gifts)) {
      const paused = await this.daemon.compareAndSetDesiredState(gift.entryId, "running", "paused").catch(() => false);
      if (paused) await updateJournal(next => { if (next.gifts[gift.entryId]) next.gifts[gift.entryId]!.pausedForQuit = true; });
    }
  }

  /** On the next start, gifts paused by a quit come back and are watched again. */
  private async resumeAfterQuit(): Promise<void> {
    const journal = await readJournal();
    for (const gift of Object.values(journal.gifts).filter(entry => entry.pausedForQuit)) {
      const resumed = await this.daemon.compareAndSetDesiredState(gift.entryId, "paused", "running").catch(() => false);
      if (resumed) await updateJournal(next => { if (next.gifts[gift.entryId]) next.gifts[gift.entryId]!.pausedForQuit = false; });
    }
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
    throw new AskGiveError("This computer couldn't start this agent. The request is still open for others.");
  }

  /**
   * An id the daemon never had (an attempt that died before its create call)
   * is answered "purged": the daemon's absent-identity rule in
   * lifecycle-administration-coordinator.ts, pinned by its own test.
   */
  private async stopAndPurge(entryId: string): Promise<void> {
    await this.daemon.setDesiredState(entryId, "stopped").catch(() => undefined);
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      const entry = (await this.daemon.list(null)).find(candidate => candidate.id === entryId);
      if (!entry || ["stopped", "absent", "failed"].includes(String(entry.observedState))) break;
      await new Promise<void>(resolve => setTimeout(resolve, READY_POLL_MS));
    }
    const generation = (await this.daemon.ensureRunning()).generation;
    const prepared = await this.daemon.purgeAgent(entryId, generation);
    if (prepared.outcome !== "revocation_required") return purged(prepared);
    if (prepared.revocationKind === "worker_session" && prepared.agentSessionId) {
      await this.grants.revokeEntryForPurge(entryId, prepared.agentSessionId);
      return purged(await this.daemon.purgeAgent(entryId, generation, prepared.agentSessionId));
    }
    await this.grants.revokeEntryForPurgeWithoutWorkerSession(entryId);
    return purged(await this.daemon.purgeAgent(entryId, generation, null, true));
  }
}

/** Only "purged" means the agent is gone. A refusal carries the daemon's reason, so a later try can be judged by it. */
function purged(result: { outcome: string; error?: string }): void {
  if (result.outcome === "purged") return;
  throw new Error(result.outcome === "invalid"
    ? (result.error?.trim() || "The daemon refused to remove this agent.")
    : "The daemon did not confirm that this agent was removed.");
}

export const askGiveCoordinator = new AskGiveCoordinator();

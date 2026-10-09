import { hostGrantApiOrigin } from "./cloud-http.js";
import { roomRequest } from "./local-room-runtime.js";
import type { DaemonManifestEntry } from "./types.js";
import type { InstalledHostGrant } from "./worker-runtime-custody.js";

export type ProviderUsageLimitPhase = "start" | "turn";

export type ProviderUsageLimitNoticeRequest = {
  apiOrigin: string;
  grantId: string;
  supervisorGrant: string;
  grantGeneration: number;
  roomId: string;
  agentKey: string;
  displayName: string;
  provider: string;
  phase: ProviderUsageLimitPhase;
  /** Epoch milliseconds, or null when the provider did not say. */
  resetsAtMs: number | null;
  /** Names this one occurrence, so a repeated report posts one notice. */
  occurrence: string;
  signal: AbortSignal;
};

const NOTICE_TIMEOUT_MS = 10_000;
/** Occurrences remembered per process, so a busy retry loop cannot post twice. */
const REMEMBERED_OCCURRENCES = 512;

/**
 * Ask the room to post its usage-limit notice. The server writes the text and
 * posts it as LetAgents; the daemon only names the agent, the provider and
 * the reset time. True when the room has the notice, posted now or before.
 */
export async function postProviderUsageLimitNotice(input: ProviderUsageLimitNoticeRequest): Promise<boolean> {
  if (hostGrantApiOrigin(input.apiOrigin) !== input.apiOrigin
    || !Number.isSafeInteger(input.grantGeneration) || input.grantGeneration < 1) return false;
  const response = await roomRequest(
    `${input.apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/usage-limit-notices`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${input.supervisorGrant}`,
        "content-type": "application/json",
        "x-letagents-supervisor-generation": String(input.grantGeneration),
      },
      body: JSON.stringify({
        generation: input.grantGeneration,
        room_id: input.roomId,
        agent_key: input.agentKey,
        display_name: input.displayName,
        provider: input.provider,
        phase: input.phase,
        resets_at: input.resetsAtMs === null ? null : new Date(input.resetsAtMs).toISOString(),
        occurrence: input.occurrence,
      }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(NOTICE_TIMEOUT_MS)]),
    });
  if (!response.ok) return false;
  const body = await response.json() as Record<string, unknown> | null;
  return body?.status === "created" || body?.status === "replayed";
}

export type ProviderUsageLimitReport = {
  entryId: string;
  phase: ProviderUsageLimitPhase;
  resetsAtMs: number | null;
  /** The failed turn's inbox item, or a stable name for a failed start. */
  occurrence: string;
};

export type ProviderUsageLimitNoticeOptions = {
  loadEntry(entryId: string): Promise<DaemonManifestEntry | null>;
  currentGrant(entry: DaemonManifestEntry): InstalledHostGrant | null;
  post?: typeof postProviderUsageLimitNotice;
  /** Told when a notice could not be posted. Never told the grant. */
  warn?: (message: string) => void;
};

/**
 * Tells each agent's room, once per occurrence, that the agent reached its
 * provider's usage limit. Posting is best effort: the agent's own state and
 * its paused deliveries already say the same thing on this computer, and a
 * notice must never delay or fail the work that found the limit.
 */
export class ProviderUsageLimitNotices {
  private readonly posted = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly controller = new AbortController();

  constructor(private readonly options: ProviderUsageLimitNoticeOptions) {}

  report(input: ProviderUsageLimitReport): void {
    const key = `${input.entryId}\u0000${input.phase}\u0000${input.occurrence}`;
    if (this.posted.has(key) || this.controller.signal.aborted) return;
    this.remember(key);
    const work = this.post(input).catch((error: unknown) => {
      // Let a later report of the same occurrence try again.
      this.posted.delete(key);
      this.options.warn?.(`Usage-limit notice for ${input.entryId} was not posted: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /** Stop posting. Notices already sent are not recalled. */
  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  private remember(key: string): void {
    this.posted.add(key);
    if (this.posted.size <= REMEMBERED_OCCURRENCES) return;
    const oldest = this.posted.values().next().value;
    if (oldest !== undefined) this.posted.delete(oldest);
  }

  private async post(input: ProviderUsageLimitReport): Promise<void> {
    const entry = await this.options.loadEntry(input.entryId);
    // A local room has no server to tell; its agent's state says it locally.
    if (!entry || entry.local_room_id) return;
    const grant = this.options.currentGrant(entry);
    if (!grant || grant.roomId !== entry.room_id) return;
    const posted = await (this.options.post ?? postProviderUsageLimitNotice)({
      apiOrigin: grant.apiUrl,
      grantId: grant.grantId,
      supervisorGrant: grant.supervisorGrant,
      grantGeneration: grant.grantGeneration,
      roomId: grant.roomId,
      agentKey: grant.agentKey,
      displayName: entry.display_name,
      provider: entry.provider,
      phase: input.phase,
      resetsAtMs: input.resetsAtMs,
      occurrence: input.occurrence,
      signal: this.controller.signal,
    });
    if (!posted) throw new Error("the room did not accept the notice");
  }
}

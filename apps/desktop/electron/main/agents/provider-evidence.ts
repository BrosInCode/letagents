import { execFileSync } from "node:child_process";

// Shared process-evidence primitives for provider adapters (plan v10 §4.8).
// Extracted verbatim from the Codex adapter (#765) so the liveness invariants
// the room ratified — birth-identity fencing, control-loss-is-not-death,
// recycled-PID non-evidence, no-orphan startup — have exactly ONE
// implementation that every provider adapter consumes.

export const DEFAULT_STOP_GRACE_MS = 5_000;
export const MAX_STREAM_PAYLOAD_BYTES = 32 * 1024;
const MAX_STREAM_COLLECTION_ENTRIES = 100;
const SENSITIVE_PAYLOAD_KEY = /(?:authorization|cookie|credential|password|secret|api[_-]?key|private[_-]?key|(?:access|refresh|auth|bearer|session|letagents)[_-]?token|(?:^|[_-])token$)/i;
const AUTHORIZATION_SECRET_ASSIGNMENT = /((?:\\?["']?)\bauthorization(?:\\?["']?)\s*[:=]\s*(?:\\?["']?))(?!(?:bearer|basic)\b)([^\\\s"',}\]]{4,})/gi;
const EMBEDDED_SECRET_ASSIGNMENT = /((?:\\?["']?)\b(?:[a-z0-9_.-]*(?:cookie|setCookie|credential|password|secret|clientSecret|dbPassword|apiKey|api[_-]?key|privateKey|private[_-]?key|token|accessToken|refreshToken|authToken|bearerToken|sessionToken|letagentsToken|(?:access|refresh|auth|bearer|session|letagents)[_-]?token))(?:\\?["']?)\s*[:=]\s*(?:\\?["']?))(?!\[REDACTED\]|<redacted>|\*{3,})([^\\\s"',}\]]{4,})/gi;
const AUTHORIZATION_SCHEME_SECRET = /(\b(?:bearer|basic)\s+)([a-z0-9._~+\/-]{8,}={0,2})/gi;
const KNOWN_SECRET = /\b(?:github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{20,}|sk-[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gi;

export function redactCredentialText(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  const safe = value
    .replace(AUTHORIZATION_SCHEME_SECRET, (_match, prefix: string) => { redacted = true; return `${prefix}[REDACTED]`; })
    .replace(AUTHORIZATION_SECRET_ASSIGNMENT, (_match, prefix: string) => { redacted = true; return `${prefix}[REDACTED]`; })
    .replace(EMBEDDED_SECRET_ASSIGNMENT, (_match, prefix: string) => { redacted = true; return `${prefix}[REDACTED]`; })
    .replace(KNOWN_SECRET, () => { redacted = true; return "[REDACTED]"; });
  return { value: safe, redacted };
}

/**
 * The minimal observed-exit shape the evidence primitives operate on. Provider
 * exit types (e.g. CodexAppServerExit) are structural supersets of this.
 */
export type ProviderProcessExit =
  | { type: "error"; error: Error }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

/** A control channel whose loss is disconnect evidence (RPC socket, stdio). */
export interface ProviderControlChannel {
  onDisconnect(listener: () => void): () => void;
}

export interface ProviderProcessEvidenceDeps {
  signalProcess(pid: number, signal: NodeJS.Signals): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, Math.max(0, ms));
    timeout.unref?.();
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function defaultSignalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall through to the direct child pid. The process group may already be
    // gone while the child exit event is still in flight.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already terminal. The observed exit promise remains authoritative.
  }
}

export function defaultGetProcessIdentity(pid: number): string | null | undefined {
  try {
    const identity = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return identity || undefined;
  } catch {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? null : undefined;
    }
  }
}

export async function defaultObserveProcessExit(
  pid: number,
  processIdentity: string,
): Promise<ProviderProcessExit> {
  while (true) {
    const currentIdentity = defaultGetProcessIdentity(pid);
    if (
      currentIdentity === null
      || (typeof currentIdentity === "string" && currentIdentity !== processIdentity)
    ) return { type: "exit", code: null, signal: null };
    await delay(1_000);
  }
}

function redactPayload(
  value: unknown,
  state: { redacted: boolean; truncated: boolean; seen: WeakSet<object> },
  key = "",
  depth = 0,
): unknown {
  if (SENSITIVE_PAYLOAD_KEY.test(key)) {
    state.redacted = true;
    return "[REDACTED]";
  }
  if (depth >= 12) {
    state.truncated = true;
    return "[MAX_DEPTH]";
  }
  if (value && typeof value === "object") {
    if (state.seen.has(value)) { state.truncated = true; return "[CIRCULAR]"; }
    state.seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_STREAM_COLLECTION_ENTRIES) state.truncated = true;
      return value.slice(0, MAX_STREAM_COLLECTION_ENTRIES).map((entry) => redactPayload(entry, state, "", depth + 1));
    }
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    let count = 0;
    for (const entryKey in record) {
      if (!Object.prototype.hasOwnProperty.call(record, entryKey)) continue;
      if (count >= MAX_STREAM_COLLECTION_ENTRIES) { state.truncated = true; break; }
      count += 1;
      try { sanitized[entryKey] = redactPayload(record[entryKey], state, entryKey, depth + 1); }
      catch { state.truncated = true; sanitized[entryKey] = "[UNREADABLE]"; }
    }
    return sanitized;
  }
  if (typeof value === "string") {
    const safe = redactCredentialText(value);
    state.redacted ||= safe.redacted;
    return safe.value;
  }
  return value;
}

export function safeStreamPayload(value: unknown): {
  payload: unknown;
  payloadTruncated: boolean;
  payloadRedacted: boolean;
} {
  const state = { redacted: false, truncated: false, seen: new WeakSet<object>() };
  const payload = redactPayload(value, state);
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? "null";
  } catch {
    return {
      payload: { preview: "[UNSERIALIZABLE_PROVIDER_PAYLOAD]" },
      payloadTruncated: true,
      payloadRedacted: state.redacted,
    };
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_STREAM_PAYLOAD_BYTES) {
    return { payload, payloadTruncated: state.truncated, payloadRedacted: state.redacted };
  }
  const serializedBytes = Buffer.from(serialized, "utf8");
  return {
    payload: { preview: serializedBytes.subarray(0, MAX_STREAM_PAYLOAD_BYTES).toString("utf8"), originalBytes: serializedBytes.length },
    payloadTruncated: true,
    payloadRedacted: state.redacted,
  };
}

/**
 * The msg_1188 invariant, verbatim from #765: control-channel loss on a
 * known-PID child is evidence that CONTROL is lost, never that the child
 * exited. On disconnect: verify the birth identity; if the exact child is
 * verifiably gone, synthesize the exit; if it is verifiably still the same
 * process, fence it (SIGTERM → grace → identity recheck → SIGKILL) and only
 * the identity-verified observed exit becomes terminal; if identity cannot be
 * verified, remain ambiguous/restart-blocking.
 */
export function observeFencedExit<E extends ProviderProcessExit>(
  channel: ProviderControlChannel,
  pid: number,
  processIdentity: string,
  observedExit: Promise<E>,
  deps: ProviderProcessEvidenceDeps,
): Promise<E | ProviderProcessExit> {
  return new Promise((resolve) => {
    let settled = false;
    let fencing = false;
    let unsubscribe = () => {};
    const finish = (exit: E | ProviderProcessExit) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(exit);
    };
    observedExit.then(finish);
    unsubscribe = channel.onDisconnect(() => {
      if (settled || fencing) return;
      fencing = true;
      void (async () => {
        const identityBeforeTerm = deps.getProcessIdentity(pid);
        if (
          identityBeforeTerm === null
          || (typeof identityBeforeTerm === "string" && identityBeforeTerm !== processIdentity)
        ) {
          finish({ type: "exit", code: null, signal: null });
          return;
        }
        if (identityBeforeTerm === undefined) return;
        deps.signalProcess(pid, "SIGTERM");
        await delay(DEFAULT_STOP_GRACE_MS);
        if (settled) return;
        // Re-check the birth identity before escalation. A recycled PID must
        // never be killed or mistaken for evidence that the original exited.
        const identityBeforeKill = deps.getProcessIdentity(pid);
        if (
          identityBeforeKill === null
          || (typeof identityBeforeKill === "string" && identityBeforeKill !== processIdentity)
        ) {
          finish({ type: "exit", code: null, signal: null });
          return;
        }
        if (identityBeforeKill === undefined) return;
        deps.signalProcess(pid, "SIGKILL");
        // Only actual process-identity disappearance can make the generation
        // terminal. A control-channel close by itself remains ambiguous and
        // restart-blocking.
        finish(await observedExit);
      })();
    });
    if (settled) unsubscribe();
  });
}

/**
 * No-orphan startup (#765 blocker 2 fix): a freshly launched child that fails
 * pre-flight (identity unverifiable, workplace missing) is terminated and its
 * real exit awaited BEFORE the launch error is thrown.
 */
export async function terminateFreshLaunch(
  launch: { pid: number | null; exited: Promise<unknown> },
  deps: ProviderProcessEvidenceDeps,
  graceMs = DEFAULT_STOP_GRACE_MS,
): Promise<void> {
  if (launch.pid === null) return;
  let alreadyExited = false;
  void launch.exited.then(() => { alreadyExited = true; });
  await Promise.resolve();
  if (alreadyExited) return;

  deps.signalProcess(launch.pid, "SIGTERM");
  const graceful = await Promise.race([
    launch.exited.then(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (graceful) return;

  deps.signalProcess(launch.pid, "SIGKILL");
  await launch.exited;
}

/**
 * Short-lived memo for the read-only CLI probes that provider preflights run
 * (`--version`, `login status`, `auth status`, `--help`). The Add Agent modal
 * runs preflight again whenever the provider, repo, permission profile or
 * model changes, and every run used to spawn the same probes again. A probe
 * result is reused for a short window. "Check again" and a setup action clear
 * the memo, because those are the moments the answer can change.
 */
export const PROVIDER_PROBE_TTL_MS = 20_000;

const probes = new Map<string, { expiresAt: number; result: Promise<unknown> }>();

export function probeKey(command: string, args: readonly string[], cwd?: string | null): string {
  return JSON.stringify([command, args, cwd ?? null]);
}

/** Runs `run` once per key per window; concurrent callers share the same promise. */
export function cachedProbe<T>(key: string, run: () => Promise<T>, now = Date.now()): Promise<T> {
  const cached = probes.get(key);
  if (cached && cached.expiresAt > now) return cached.result as Promise<T>;
  const result = run();
  probes.set(key, { expiresAt: now + PROVIDER_PROBE_TTL_MS, result });
  result.catch(() => {
    if (probes.get(key)?.result === result) probes.delete(key);
  });
  return result;
}

export function clearProbeCache(): void {
  probes.clear();
}

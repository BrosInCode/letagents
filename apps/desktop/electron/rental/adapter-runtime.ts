/**
 * Generic meter adapter scheduler skeleton.
 *
 * The runtime in this file owns the lifecycle of per-IDE adapters:
 *
 *   1. Holds a registry of adapter instances by provider key.
 *   2. Periodically asks each registered adapter for a new native quota
 *      snapshot and usage delta.
 *   3. Hands the resulting `AdapterNativeQuotaSnapshot` + `AdapterLrtEstimate`
 *      to the IPC layer for transport to the API (lands in p2.3b).
 *
 * In p2.3a the runtime is intentionally minimal: it stores adapters and
 * exposes them for unit-testing. Polling/scheduling/IPC wiring lands
 * once p2.2 (server-side ingest endpoint) and p2.3b (IPC + report path)
 * are merged.
 *
 * Spec §17.7. Per LivelyPeak's msg_63 dissent, adapters run desktop-side
 * (Electron main / MCP-local) because they read local IDE files. No
 * server-side filesystem access.
 */

import type { DesktopMeterAdapter } from "./adapter-types.js";

/**
 * Mutable in-process registry of meter adapters keyed by provider.
 *
 * Phase 2 PRs register their adapters here:
 *   p2.3 (this) → claude_code
 *   p2.4         → codex
 *   p2.5         → antigravity
 *   p2.7         → cursor
 */
export class AdapterRegistry {
  private readonly byProvider = new Map<string, DesktopMeterAdapter>();

  register(adapter: DesktopMeterAdapter): void {
    if (this.byProvider.has(adapter.provider)) {
      throw new Error(`adapter already registered for provider: ${adapter.provider}`);
    }
    this.byProvider.set(adapter.provider, adapter);
  }

  /** Replace an existing adapter. Useful in tests; production callers should `register` exactly once per provider. */
  override(adapter: DesktopMeterAdapter): void {
    this.byProvider.set(adapter.provider, adapter);
  }

  unregister(provider: string): void {
    this.byProvider.delete(provider);
  }

  get(provider: string): DesktopMeterAdapter | null {
    return this.byProvider.get(provider) ?? null;
  }

  list(): DesktopMeterAdapter[] {
    return Array.from(this.byProvider.values());
  }
}

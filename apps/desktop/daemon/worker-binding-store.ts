import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export interface WorkerSessionBinding {
  entry_id: string;
  room_id: string;
  work_attempt_id: string;
  execution_generation_id: string;
  agent_session_id: string;
  agent_session_token: string;
  api_url: string;
  last_sequence: number;
  last_observed_at_ms: number;
  updated_at: string;
}

type StoredBindings = { version: 1; bindings: Record<string, WorkerSessionBinding> };
type WorkerSessionBindingInput = Omit<WorkerSessionBinding, "last_sequence" | "last_observed_at_ms" | "updated_at">;

/**
 * Daemon-private worker credentials. These deliberately live outside the
 * renderer-visible manifest and audit log and are persisted with owner-only
 * permissions so a daemon replacement can continue monotonic native activity.
 */
export class WorkerBindingStore {
  private mutations: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async get(entryId: string): Promise<WorkerSessionBinding | null> {
    return (await this.load()).bindings[entryId] ?? null;
  }

  async list(): Promise<WorkerSessionBinding[]> {
    return Object.values((await this.load()).bindings);
  }

  async bind(input: WorkerSessionBindingInput): Promise<WorkerSessionBinding> {
    this.validate(input);
    return this.serialize(async () => {
      const stored = await this.load();
      const prior = stored.bindings[input.entry_id];
      const binding: WorkerSessionBinding = {
        ...input,
        api_url: new URL(input.api_url).origin,
        last_sequence: prior?.agent_session_id === input.agent_session_id ? prior.last_sequence : 0,
        last_observed_at_ms: prior?.agent_session_id === input.agent_session_id && Number.isSafeInteger(prior.last_observed_at_ms) ? prior.last_observed_at_ms : 0,
        updated_at: new Date().toISOString(),
      };
      await this.write({ version: 1, bindings: { ...stored.bindings, [input.entry_id]: binding } });
      return binding;
    });
  }

  async publish<T extends { accepted: boolean }>(
    entryId: string,
    observedAtMs: number,
    operation: (publication: { binding: WorkerSessionBinding; sequence: number; observed_at: string }) => Promise<T>,
  ): Promise<(T & { sequence: number; observed_at: string }) | null> {
    return this.serialize(async () => {
      const stored = await this.load();
      const prior = stored.bindings[entryId];
      if (!prior) return null;
      const nowMs = Date.now();
      const candidateMs = Number.isFinite(observedAtMs) ? Math.min(Math.floor(observedAtMs), nowMs) : nowMs;
      const priorObservedAtMs = Number.isSafeInteger(prior.last_observed_at_ms) ? prior.last_observed_at_ms : 0;
      const effectiveObservedAtMs = Math.max(candidateMs, priorObservedAtMs + 1);
      const sequence = Math.max(prior.last_sequence + 1, effectiveObservedAtMs);
      const observed_at = new Date(effectiveObservedAtMs).toISOString();
      const binding = { ...prior, last_sequence: sequence, last_observed_at_ms: effectiveObservedAtMs, updated_at: observed_at };
      await this.write({ version: 1, bindings: { ...stored.bindings, [entryId]: binding } });
      // Keep the same credential-store mutex through transport completion. A
      // later reservation must never overtake this request and make an older
      // response self-fence a still-valid worker binding.
      const result = await operation({ binding, sequence, observed_at });
      if (!result.accepted) {
        const { [entryId]: _removed, ...bindings } = (await this.load()).bindings;
        await this.write({ version: 1, bindings });
      }
      return { ...result, sequence, observed_at };
    });
  }

  async unbind(entryId: string, expectedSessionId?: string): Promise<boolean> {
    return this.serialize(async () => {
      const stored = await this.load();
      const current = stored.bindings[entryId];
      if (!current || expectedSessionId && current.agent_session_id !== expectedSessionId) return false;
      const { [entryId]: _removed, ...bindings } = stored.bindings;
      await this.write({ version: 1, bindings });
      return true;
    });
  }

  private validate(input: WorkerSessionBindingInput): void {
    for (const field of ["entry_id", "room_id", "work_attempt_id", "execution_generation_id", "agent_session_id", "agent_session_token", "api_url"] as const) {
      if (!input[field]?.trim()) throw new Error(`Worker binding ${field} is required.`);
    }
    const url = new URL(input.api_url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Worker binding api_url must use HTTP or HTTPS.");
  }

  private async load(): Promise<StoredBindings> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as StoredBindings;
      if (value.version !== 1 || !value.bindings || typeof value.bindings !== "object") throw new Error("Worker binding state is malformed.");
      return value;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bindings: {} };
      throw error;
    }
  }

  private async write(value: StoredBindings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
    const directory = await open(dirname(this.path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations;
    let release!: () => void;
    this.mutations = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

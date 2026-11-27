import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from "vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopProviderSignInUpdate,
} from "../../../../../electron/ipc-types";
import { visibleDesktopAgentProviders } from "../../../domain/managed-agents";
import { desktopIpc } from "../../../ipc/index.js";
import { contextualAddAgentError } from "../content/add-agent/add-agent-errors";

export type OnboardingProviderState = "checking" | "ready" | "signin" | "signing-in" | "missing" | "unavailable";

export interface OnboardingProviderSignIn {
  url: string | null;
  code: string | null;
  acceptsCode: boolean;
  inTerminal: boolean;
  verifying: boolean;
}

export interface OnboardingProvider {
  id: DesktopAgentProviderId;
  name: string;
  state: OnboardingProviderState;
  /** One short line: "Signed in", "Needs sign-in", "Not installed", or the preflight reason. */
  detail: string;
  /** Present while this provider's in-app sign-in runs. */
  signIn?: OnboardingProviderSignIn;
}

export interface OnboardingAgentsOptions {
  /** The agent step is on screen. Nothing runs, and no update is applied, while this is false. */
  active: () => boolean;
}

/** The agent apps the first-run screen offers, in this order. OpenCode / Open Model stay out of it. */
export const ONBOARDING_PROVIDER_IDS = ["claude-code", "codex", "cursor", "antigravity"] as const satisfies readonly DesktopAgentProviderId[];

const PROVIDER_NAMES: Record<(typeof ONBOARDING_PROVIDER_IDS)[number], string> = {
  "claude-code": "Claude Code",
  // The first-run screen names Codex by the product people sign in to.
  codex: "ChatGPT",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

/** At most this many provider checks run at once: each one starts the provider's CLI. */
export const ONBOARDING_PREFLIGHT_CONCURRENCY = 2;
/** A plain refresh inside this window reuses the last result instead of starting the CLIs again. */
export const ONBOARDING_PREFLIGHT_FRESH_MS = 10_000;

const SIGN_IN_ACTIVE = new Set<DesktopProviderSignInUpdate["state"]>(["starting", "waiting", "verifying"]);

export function onboardingProviderName(id: DesktopAgentProviderId): string {
  return PROVIDER_NAMES[id as keyof typeof PROVIDER_NAMES] ?? id;
}

/** What one preflight result means on the first-run screen. */
export function onboardingStateFromPreflight(
  preflight: Pick<DesktopAgentProviderPreflight, "status" | "canStart" | "nextAction" | "message" | "detail">,
): { state: Exclude<OnboardingProviderState, "checking" | "signing-in">; detail: string } {
  if (preflight.status === "ready" && preflight.canStart) return { state: "ready", detail: "Signed in" };
  if (preflight.status === "auth_required" || preflight.nextAction === "authenticate") {
    return { state: "signin", detail: "Needs sign-in" };
  }
  if (
    preflight.status === "missing_runtime"
    || preflight.nextAction === "install_external_runtime"
    || preflight.nextAction === "install_runtime"
  ) {
    return { state: "missing", detail: "Not installed" };
  }
  const reason = preflight.message?.trim() || preflight.detail?.trim() || "Not available right now.";
  return { state: "unavailable", detail: reason };
}

/**
 * "<name> can't start yet: <reason>", unless the reason already says which agent failed
 * (a failed check reads "Couldn't check <name>: …"); then the reason alone.
 */
export function onboardingUnavailableText(name: string, detail: string): string {
  const reason = detail.trim();
  if (!reason) return `${name} can't start yet.`;
  // The first room has no project folder, so an agent that works only in a repository can't be the first one.
  if (/local repository|choose a (project|repository)|project folder/i.test(reason)) {
    return `${name} works inside a project folder. Pick another agent now, and add ${name} later from a project room.`;
  }
  if (/^(couldn['’]t|could not|can['’]t|cannot)\b/i.test(reason) || reason.toLowerCase().includes(name.toLowerCase())) return reason;
  return `${name} can't start yet: ${reason}`;
}

/** A tiny FIFO limiter: a finished check hands its slot straight to the next one. */
function createLimiter(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/**
 * The agent apps on the first-run "Pick your first agent." screen: their
 * readiness, and the in-app sign-in from Add Agent (one provider at a time).
 */
export function useOnboardingAgents(options: OnboardingAgentsOptions) {
  const providers = ref<OnboardingProvider[]>(
    ONBOARDING_PROVIDER_IDS.map((id) => ({ id, name: onboardingProviderName(id), state: "checking", detail: "Checking…" })),
  ) as Ref<OnboardingProvider[]>;
  const loading = ref(false);
  const error = ref<string | null>(null);
  const signInError = ref<string | null>(null);

  const listed = new Map<DesktopAgentProviderId, DesktopAgentProvider>();
  let listing: Promise<boolean> | null = null;
  let listedOnce = false;
  const inFlight = new Map<DesktopAgentProviderId, Promise<void>>();
  const checkedAt = new Map<DesktopAgentProviderId, number>();
  /** Bumped when a sign-in starts, so a check that began before it cannot overwrite the sign-in's result. */
  const epochs = new Map<DesktopAgentProviderId, number>();
  const withSlot = createLimiter(ONBOARDING_PREFLIGHT_CONCURRENCY);
  let signingId: DesktopAgentProviderId | null = null;
  /** Bumped by each sign-in click: a click that waited for an earlier cancel gives way to a later click. */
  let signInToken = 0;
  let refreshing: Promise<void> | null = null;
  let refreshToken = 0;
  let disposed = false;

  const find = (id: DesktopAgentProviderId) => providers.value.find((provider) => provider.id === id) ?? null;
  const live = () => !disposed && options.active();

  function patch(id: DesktopAgentProviderId, next: Partial<OnboardingProvider>): void {
    providers.value = providers.value.map((provider) => {
      if (provider.id !== id) return provider;
      const merged = { ...provider, ...next };
      if ("signIn" in next && !next.signIn) delete merged.signIn;
      return merged;
    });
  }

  async function loadProviders(force: boolean): Promise<boolean> {
    if (listedOnce && !force) return true;
    if (listing) return listing;
    listing = (async () => {
      try {
        const all = visibleDesktopAgentProviders(await desktopIpc.workers.listAgentProviders());
        if (disposed) return false;
        listed.clear();
        for (const provider of all) listed.set(provider.id, provider);
        const offered = ONBOARDING_PROVIDER_IDS.filter((id) => listed.has(id));
        providers.value = offered.map((id) => find(id)
          ?? { id, name: onboardingProviderName(id), state: "checking", detail: "Checking…" });
        listedOnce = true;
        error.value = null;
        return true;
      } catch (cause) {
        if (!disposed) {
          error.value = contextualAddAgentError("Couldn't list your agent apps", cause, "Try again in a moment.");
        }
        return false;
      } finally {
        listing = null;
      }
    })();
    return listing;
  }

  /**
   * One preflight for one provider. A second call while one runs shares it;
   * `fresh` waits for that one, then checks again (a sign-in just finished).
   */
  function check(id: DesktopAgentProviderId, opts: { fresh?: boolean; refreshEnvironment?: boolean } = {}): Promise<void> {
    const running = inFlight.get(id);
    if (running && !opts.fresh) return running;
    const run = (async () => {
      if (running) await running.catch(() => undefined);
      await withSlot(async () => {
        if (disposed) return;
        const epoch = epochs.get(id) ?? 0;
        const stale = () => disposed || signingId === id || (epochs.get(id) ?? 0) !== epoch;
        try {
          const result = await desktopIpc.workers.runAgentProviderPreflight(id, {
            roomOnly: true,
            ...(opts.refreshEnvironment ? { refreshEnvironment: true } : {}),
          });
          // A sign-in in progress owns this row until it ends.
          if (stale()) return;
          checkedAt.set(id, Date.now());
          patch(id, { ...onboardingStateFromPreflight(result), signIn: undefined });
        } catch (cause) {
          if (stale()) return;
          checkedAt.delete(id);
          patch(id, {
            state: "unavailable",
            detail: contextualAddAgentError(`Couldn't check ${onboardingProviderName(id)}`, cause, "Try again in a moment."),
            signIn: undefined,
          });
        }
      });
    })();
    const tracked = run.finally(() => {
      if (inFlight.get(id) === tracked) inFlight.delete(id);
    });
    inFlight.set(id, tracked);
    return tracked;
  }

  /** Checks every offered provider, two at a time. Results seen in the last 10 s are kept unless forced. */
  async function refresh(force = false): Promise<void> {
    if (!live()) return;
    if (refreshing && !force) return refreshing;
    const token = ++refreshToken;
    const run = (async () => {
      loading.value = true;
      try {
        if (!(await loadProviders(force))) return;
        const now = Date.now();
        const due = providers.value.filter((provider) => {
          if (provider.state === "signing-in") return false;
          if (inFlight.has(provider.id)) return force;
          const at = checkedAt.get(provider.id);
          return force || at === undefined || now - at >= ONBOARDING_PREFLIGHT_FRESH_MS;
        });
        await Promise.all(due.map((provider) => check(provider.id, force
          ? { fresh: true, refreshEnvironment: true }
          : {})));
      } finally {
        if (token === refreshToken) refreshing = null;
        loading.value = Boolean(refreshing) || inFlight.size > 0;
      }
    })();
    refreshing = run;
    return run;
  }

  function endSignIn(id: DesktopAgentProviderId, next: Partial<OnboardingProvider>): void {
    if (signingId === id) signingId = null;
    patch(id, { ...next, signIn: undefined });
  }

  function accept(update: DesktopProviderSignInUpdate): void {
    if (!live() || update.providerId !== signingId) return;
    const id = update.providerId;
    const provider = find(id);
    if (!provider) return;
    if (SIGN_IN_ACTIVE.has(update.state)) {
      patch(id, {
        state: "signing-in",
        detail: "Signing in…",
        signIn: {
          url: update.url ?? provider.signIn?.url ?? null,
          code: update.code ?? provider.signIn?.code ?? null,
          acceptsCode: update.acceptsCode ?? provider.signIn?.acceptsCode ?? false,
          inTerminal: update.inTerminal ?? provider.signIn?.inTerminal ?? false,
          verifying: update.state === "verifying",
        },
      });
      return;
    }
    if (update.state === "signed_in") {
      // Keep the row on "verifying" until the provider's own check says it is ready.
      signingId = null;
      patch(id, { signIn: { ...(provider.signIn ?? { url: null, code: null, acceptsCode: false, inTerminal: false }), verifying: true } });
      void check(id, { fresh: true });
      return;
    }
    if (update.state === "failed") {
      signInError.value = update.message?.trim() || `Couldn't sign in to ${provider.name}. Try again.`;
    }
    endSignIn(id, { state: "signin", detail: "Needs sign-in" });
  }

  const unsubscribe = desktopIpc.workers?.onProviderSignInUpdate?.(accept) ?? (() => undefined);

  async function cancelSignIn(id: DesktopAgentProviderId): Promise<void> {
    if (signingId !== id) return;
    endSignIn(id, { state: "signin", detail: "Needs sign-in" });
    await desktopIpc.workers.cancelProviderSignIn(id).catch(() => undefined);
  }

  async function signIn(id: DesktopAgentProviderId): Promise<void> {
    if (!live() || signingId === id) return;
    const provider = find(id);
    if (!provider || provider.state !== "signin") return;
    const token = ++signInToken;
    // One sign-in at a time: starting another ends the first.
    if (signingId) await cancelSignIn(signingId);
    if (token !== signInToken || !live()) return;
    signingId = id;
    // Any other row still on "Signing in…" lost its sign-in to a later click: give it back its button.
    for (const other of providers.value) {
      if (other.id === id || other.state !== "signing-in" || inFlight.has(other.id)) continue;
      patch(other.id, { state: "signin", detail: "Needs sign-in", signIn: undefined });
      void desktopIpc.workers.cancelProviderSignIn(other.id).catch(() => undefined);
    }
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    signInError.value = null;
    patch(id, {
      state: "signing-in",
      detail: "Signing in…",
      signIn: { url: null, code: null, acceptsCode: false, inTerminal: false, verifying: false },
    });
    try {
      accept(await desktopIpc.workers.startProviderSignIn(id));
    } catch (cause) {
      if (signingId !== id) return;
      signInError.value = contextualAddAgentError(`Couldn't sign in to ${provider.name}`, cause, "Try again in a moment.");
      endSignIn(id, { state: "signin", detail: "Needs sign-in" });
    }
  }

  async function submitCode(id: DesktopAgentProviderId, code: string): Promise<void> {
    const trimmed = code.trim();
    const current = find(id);
    if (!live() || signingId !== id || !trimmed || !current?.signIn || current.signIn.verifying) return;
    signInError.value = null;
    patch(id, { signIn: { ...current.signIn, verifying: true } });
    try {
      const next = await desktopIpc.workers.submitProviderSignInCode(id, trimmed);
      if (next) accept(next);
    } catch (cause) {
      if (signingId !== id) return;
      signInError.value = contextualAddAgentError("Couldn't use that code", cause, "Paste the code from the browser again.");
      const latest = find(id);
      if (latest?.signIn) patch(id, { signIn: { ...latest.signIn, verifying: false } });
    }
  }

  async function openSignInLink(id: DesktopAgentProviderId): Promise<void> {
    const url = find(id)?.signIn?.url;
    if (!live() || !url) return;
    try {
      await desktopIpc.app.openExternalUrl(url);
    } catch (cause) {
      signInError.value = contextualAddAgentError("Couldn't open the sign-in page", cause, "Copy the link into your browser.");
    }
  }

  async function openInstall(id: DesktopAgentProviderId): Promise<void> {
    if (!live()) return;
    const url = listed.get(id)?.runtimeInstallUrl?.trim();
    const name = onboardingProviderName(id);
    if (!url) {
      signInError.value = `Install ${name} from its website, then come back here.`;
      return;
    }
    try {
      await desktopIpc.app.openExternalUrl(url);
    } catch (cause) {
      signInError.value = contextualAddAgentError(
        "Couldn't open the installation guide",
        cause,
        `Open the ${name} installation guide in your browser and check again after installing.`,
      );
    }
  }

  // The step coming on screen checks the providers; leaving it ends a running sign-in.
  watch(() => options.active(), (active) => {
    if (active) void refresh();
    else if (signingId) void cancelSignIn(signingId);
  }, { immediate: true });

  if (getCurrentScope()) {
    onScopeDispose(() => {
      const running = signingId;
      disposed = true;
      unsubscribe();
      if (running) {
        signingId = null;
        void desktopIpc.workers.cancelProviderSignIn(running).catch(() => undefined);
      }
    });
  }

  /** Check one agent again now, with a fresh shell environment (a click on an agent that could not be used). */
  function recheck(id: DesktopAgentProviderId): Promise<void> {
    if (!live()) return Promise.resolve();
    patch(id, { state: "checking", detail: "Checking…" });
    return check(id, { fresh: true, refreshEnvironment: true });
  }

  return { providers, loading, error, signInError, refresh, recheck, signIn, cancelSignIn, submitCode, openSignInLink, openInstall };
}

export type OnboardingAgents = ReturnType<typeof useOnboardingAgents>;

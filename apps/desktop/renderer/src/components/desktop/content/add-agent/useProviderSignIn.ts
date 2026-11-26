import { computed, getCurrentInstance, onBeforeUnmount, ref, watch } from "vue";
import type {
  DesktopAgentProviderId,
  DesktopProviderSignInUpdate,
} from "../../../../../../electron/ipc-types";
import { copyTextToClipboard } from "../../../../../../../../shared/ui/clipboard";
import { desktopIpc } from "../../../../ipc/index.js";
import { contextualAddAgentError } from "./add-agent-errors";

const ACTIVE_STATES = new Set<DesktopProviderSignInUpdate["state"]>(["starting", "waiting", "verifying"]);

export interface ProviderSignInOptions {
  open: () => boolean;
  providerId: () => DesktopAgentProviderId | null;
  providerName: () => string;
  /** A verified sign-in: check the provider again so the window moves on. */
  onSignedIn: (update: DesktopProviderSignInUpdate) => void;
}

/** The provider sign-in that the desktop runs for the selected provider in Add Agent. */
export function useProviderSignIn(options: ProviderSignInOptions) {
  const update = ref<DesktopProviderSignInUpdate | null>(null);
  const pastedCode = ref("");
  const submittingCode = ref(false);
  const codeCopied = ref(false);
  const error = ref<string | null>(null);
  const active = computed(() => Boolean(update.value && ACTIVE_STATES.has(update.value.state)));

  function accept(next: DesktopProviderSignInUpdate): void {
    if (!options.open() || next.providerId !== options.providerId()) return;
    if (next.state === "cancelled") {
      update.value = null;
      return;
    }
    if (next.code !== update.value?.code) codeCopied.value = false;
    update.value = next;
    if (next.state === "signed_in") {
      update.value = null;
      pastedCode.value = "";
      options.onSignedIn(next);
    }
  }

  const unsubscribe = desktopIpc.workers?.onProviderSignInUpdate?.(accept) ?? (() => undefined);

  async function start(): Promise<void> {
    const providerId = options.providerId();
    if (!providerId || active.value) return;
    error.value = null;
    pastedCode.value = "";
    try {
      accept(await desktopIpc.workers.startProviderSignIn(providerId));
    } catch (cause) {
      if (options.providerId() === providerId) {
        error.value = contextualAddAgentError(`Couldn't sign in to ${options.providerName()}`, cause, "Try again, or copy the sign-in command.");
      }
    }
  }

  async function submitCode(): Promise<void> {
    const providerId = options.providerId();
    const code = pastedCode.value.trim();
    if (!providerId || !code || submittingCode.value) return;
    submittingCode.value = true;
    error.value = null;
    try {
      const next = await desktopIpc.workers.submitProviderSignInCode(providerId, code);
      pastedCode.value = "";
      if (next) accept(next);
    } catch (cause) {
      error.value = contextualAddAgentError("Couldn't use that code", cause, "Paste the code from the browser again.");
    } finally {
      submittingCode.value = false;
    }
  }

  async function cancel(providerId = update.value?.providerId ?? null): Promise<void> {
    if (!providerId) return;
    update.value = null;
    pastedCode.value = "";
    error.value = null;
    await desktopIpc.workers.cancelProviderSignIn(providerId).catch(() => undefined);
  }

  async function copyCode(): Promise<void> {
    const code = update.value?.code;
    if (code) codeCopied.value = await copyTextToClipboard(code);
  }

  async function openLink(): Promise<void> {
    const url = update.value?.url;
    if (!url) return;
    try {
      await desktopIpc.app.openExternalUrl(url);
    } catch (cause) {
      error.value = contextualAddAgentError("Couldn't open the sign-in page", cause, "Copy the link into your browser.");
    }
  }

  // A sign-in belongs to the provider it started for: a provider switch or a
  // closed window ends it, so no login keeps running out of sight.
  watch(options.providerId, (_next, previous) => {
    const running = update.value;
    error.value = null;
    if (running && running.providerId === previous && active.value) void cancel(previous);
    else update.value = null;
  });
  watch(options.open, (open) => {
    if (!open && active.value) void cancel();
    if (!open) {
      update.value = null;
      error.value = null;
    }
  });
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      unsubscribe();
      if (active.value) void cancel();
    });
  }

  function setPastedCode(value: string): void {
    pastedCode.value = value;
  }

  return { update, active, pastedCode, setPastedCode, submittingCode, codeCopied, error, start, submitCode, cancel, copyCode, openLink };
}

export type ProviderSignInController = ReturnType<typeof useProviderSignIn>;

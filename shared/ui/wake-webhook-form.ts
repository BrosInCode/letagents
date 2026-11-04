/**
 * The webhook wake-up form a person fills in for one of their own agents:
 * its validation (the same limits the server applies), the signing secret
 * the app makes and shows once, the words for a test result, and the form's
 * state as a composable, so the desktop and web apps render one behaviour
 * and the tests drive it without a DOM.
 */
import { computed, reactive, ref, shallowRef, type Ref } from "vue";

import {
  WAKE_RULE_LIMITS,
  type WakeRule,
  type WakeRuleTestResult,
  type WakeWebhookAgent,
  type WakeWebhookApi,
  type WakeWebhookFormInput,
} from "../wake-rules.mjs";

export const WAKE_WEBHOOK_SECRET_CHARS = 32;
/** The help text under the key field. */
export const WAKE_WEBHOOK_KEY_HELP = "The receiver's sender key, sent as Authorization: Bearer. Grok Bot routines need one.";
/** Shown with the secret, once. */
export const WAKE_WEBHOOK_SECRET_NOTICE = "Receivers that verify X-LetAgents-Signature need this secret; LetAgents cannot show it again.";
/** Shown under the list of wake-ups, next to Send test. */
export const WAKE_WEBHOOK_TEST_HELP = "Send test sends one delivery now and shows the receiver's answer. A test counts against the rule's hourly budget of 20 wake-ups.";

const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** 32 base64url characters from 24 random bytes (6 bits each): the shared signing secret. */
export function generateWakeWebhookSecret(random: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes)): string {
  const bytes = random(new Uint8Array((WAKE_WEBHOOK_SECRET_CHARS * 6) / 8));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const secret = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (secret.length !== WAKE_WEBHOOK_SECRET_CHARS) throw new Error("The signing secret came out the wrong length.");
  return secret;
}

export interface WakeWebhookDraft {
  agentKey: string;
  url: string;
  bearer: string;
  note: string;
}

export type WakeWebhookDraftErrors = Partial<Record<keyof WakeWebhookDraft, string>>;

export type WakeWebhookValidation =
  | { ok: true; agentKey: string; input: Omit<WakeWebhookFormInput, "secret"> }
  | { ok: false; errors: WakeWebhookDraftErrors };

/**
 * Check the draft the way the server will, so a refusal is explained before
 * the request goes out. The URL must be https with no user name or password
 * (the server also resolves its host and refuses private addresses); the key
 * is 8 to 512 visible ASCII characters with no spaces; the note is one short
 * plain-text line.
 */
export function validateWakeWebhookDraft(draft: WakeWebhookDraft, agents: readonly WakeWebhookAgent[]): WakeWebhookValidation {
  const errors: WakeWebhookDraftErrors = {};
  const agentKey = draft.agentKey.trim();
  if (!agentKey || !agents.some((agent) => agent.agent_key === agentKey)) errors.agentKey = "Choose one of your agents in this room.";
  const url = draft.url.trim();
  let parsed: URL | null = null;
  try {
    parsed = url ? new URL(url) : null;
  } catch {
    parsed = null;
  }
  if (!url) errors.url = "Enter the receiver's https URL.";
  else if (url.length > WAKE_RULE_LIMITS.webhookUrlMaxLength) errors.url = `The URL can be at most ${WAKE_RULE_LIMITS.webhookUrlMaxLength} characters.`;
  else if (!parsed || parsed.protocol !== "https:" || !parsed.hostname) errors.url = "The URL must start with https://.";
  else if (parsed.username || parsed.password) errors.url = "The URL cannot carry a user name or password.";
  else if (parsed.port && parsed.port !== "443") errors.url = "The URL must use port 443.";
  const bearer = draft.bearer.trim();
  if (bearer && (bearer.length < WAKE_RULE_LIMITS.webhookBearerMinLength || bearer.length > WAKE_RULE_LIMITS.webhookBearerMaxLength || !VISIBLE_ASCII.test(bearer))) {
    errors.bearer = `The key must be ${WAKE_RULE_LIMITS.webhookBearerMinLength} to ${WAKE_RULE_LIMITS.webhookBearerMaxLength} visible ASCII characters without spaces.`;
  }
  const note = draft.note.trim();
  if (note.length > WAKE_RULE_LIMITS.noteMaxLength) errors.note = `The note can be at most ${WAKE_RULE_LIMITS.noteMaxLength} characters.`;
  else if (CONTROL_CHARACTERS.test(note)) errors.note = "The note must be plain text.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, agentKey, input: { url, ...(bearer ? { bearer } : {}), note: note || null } };
}

/** The one line shown under Send test. */
export function describeWakeTestResult(result: WakeRuleTestResult): { tone: "ok" | "rejected" | "failed"; text: string } {
  if (result.status >= 200 && result.status < 300) return { tone: "ok", text: result.resumed ? "Accepted; the rule is active again" : "Accepted" };
  if (result.status === 401 || result.status === 403) return { tone: "rejected", text: "The receiver rejected the key" };
  const status = result.status > 0 ? ` (${result.status})` : "";
  return { tone: "failed", text: `${result.error_class ?? "failed"}${status}` };
}

/** A webhook rule of one of the viewer's own agents: the rows the form lists. */
export function isOwnWakeWebhookRule(rule: WakeRule, agentKeys: ReadonlySet<string>): boolean {
  return rule.delivery?.kind === "webhook" && agentKeys.has(rule.agent_key);
}

/** The viewer's webhook rules in a room, held ones first, newest first within each group. */
export function selectOwnWakeWebhookRules(rules: readonly WakeRule[], agents: readonly WakeWebhookAgent[]): WakeRule[] {
  const keys = new Set(agents.map((agent) => agent.agent_key));
  return rules.filter((rule) => isOwnWakeWebhookRule(rule, keys))
    .sort((left, right) => Number(right.status === "active" || right.status === "paused") - Number(left.status === "active" || left.status === "paused")
      || right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
}

export function wakeWebhookRuleStatusLabel(rule: Pick<WakeRule, "status">): string {
  switch (rule.status) {
    case "active": return "Active";
    case "paused": return "Paused";
    case "cancelled": return "Cancelled";
    case "retired": return "Ended";
    case "expired": return "Expired";
    default: return rule.status;
  }
}

/** "last 200" or "last http_4xx (401)" or "no delivery yet". */
export function wakeWebhookLastResultLabel(rule: WakeRule): string {
  const delivery = rule.delivery;
  if (!delivery || delivery.last_attempt_at == null) return "no delivery yet";
  if (delivery.last_error) return `last ${delivery.last_error}${delivery.last_status ? ` (${delivery.last_status})` : ""}`;
  return delivery.last_status ? `last ${delivery.last_status}` : "no delivery yet";
}

export interface RevealedWakeWebhookSecret {
  ruleId: string;
  agentName: string;
  secret: string;
  /** Whether this save made a new rule (false: the same rule was renewed with the new secret). */
  created: boolean;
}

export interface WakeWebhookTestState {
  state: "sending" | "done" | "error";
  tone?: "ok" | "rejected" | "failed";
  text: string;
}

export interface WakeWebhookFormOptions {
  roomId: Ref<string>;
  agents: Ref<readonly WakeWebhookAgent[]>;
  api: WakeWebhookApi;
  /** Called after a save or cancel, so the host re-reads the room's rules. */
  onChanged?: () => void;
  makeSecret?: () => string;
}

/**
 * The form's state. The signing secret is made here when the draft is saved,
 * sent with the rule, and kept only in `revealedSecret` until the person
 * dismisses it; nothing else ever holds it. The key and the URL are sent
 * once and never read back (the server never returns them).
 */
export function useWakeWebhookForm(options: WakeWebhookFormOptions) {
  const open = ref(false);
  const draft = reactive<WakeWebhookDraft>({ agentKey: "", url: "", bearer: "", note: "" });
  const errors = ref<WakeWebhookDraftErrors>({});
  const saving = ref(false);
  const saveError = ref<string | null>(null);
  const revealedSecret = shallowRef<RevealedWakeWebhookSecret | null>(null);
  const tests = reactive(new Map<string, WakeWebhookTestState>());
  const cancelling = reactive(new Set<string>());
  const cancelErrors = reactive(new Map<string, string>());
  const makeSecret = options.makeSecret ?? generateWakeWebhookSecret;

  const canSubmit = computed(() => !saving.value && options.agents.value.length > 0);

  function reset(): void {
    draft.agentKey = options.agents.value.length === 1 ? options.agents.value[0]!.agent_key : "";
    draft.url = "";
    draft.bearer = "";
    draft.note = "";
    errors.value = {};
    saveError.value = null;
  }

  function show(): void {
    reset();
    revealedSecret.value = null;
    open.value = true;
  }

  function hide(): void {
    open.value = false;
    reset();
  }

  function dismissSecret(): void {
    revealedSecret.value = null;
  }

  async function submit(): Promise<boolean> {
    if (!canSubmit.value) return false;
    const checked = validateWakeWebhookDraft(draft, options.agents.value);
    if (!checked.ok) {
      errors.value = checked.errors;
      return false;
    }
    errors.value = {};
    saveError.value = null;
    saving.value = true;
    const secret = makeSecret();
    try {
      const { rule, created } = await options.api.add(options.roomId.value, checked.agentKey, { ...checked.input, secret });
      revealedSecret.value = { ruleId: rule.id, agentName: rule.agent_name, secret, created };
      open.value = false;
      reset();
      options.onChanged?.();
      return true;
    } catch (error) {
      saveError.value = error instanceof Error && error.message ? error.message : "The wake-up could not be saved. Try again.";
      return false;
    } finally {
      saving.value = false;
    }
  }

  async function sendTest(rule: Pick<WakeRule, "id">): Promise<void> {
    if (tests.get(rule.id)?.state === "sending") return;
    tests.set(rule.id, { state: "sending", text: "Sending…" });
    try {
      const result = await options.api.test(options.roomId.value, rule.id);
      tests.set(rule.id, { state: "done", ...describeWakeTestResult(result) });
      options.onChanged?.();
    } catch (error) {
      tests.set(rule.id, { state: "error", tone: "failed", text: error instanceof Error && error.message ? error.message : "The test could not be sent." });
    }
  }

  async function cancel(rule: Pick<WakeRule, "id">): Promise<void> {
    if (cancelling.has(rule.id)) return;
    cancelling.add(rule.id);
    cancelErrors.delete(rule.id);
    try {
      await options.api.cancel(options.roomId.value, rule.id);
      tests.delete(rule.id);
      options.onChanged?.();
    } catch (error) {
      cancelErrors.set(rule.id, error instanceof Error && error.message ? error.message : "The wake-up could not be cancelled. Try again.");
    } finally {
      cancelling.delete(rule.id);
    }
  }

  return {
    open, draft, errors, saving, saveError, revealedSecret, tests, cancelling, cancelErrors, canSubmit,
    show, hide, submit, dismissSecret, sendTest, cancel,
  };
}

export type WakeWebhookForm = ReturnType<typeof useWakeWebhookForm>;

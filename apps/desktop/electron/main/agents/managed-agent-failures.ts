import type {
  DesktopManagedAgentFailure,
  DesktopManagedAgentFailureCode,
} from "../../ipc-types.js";

type FailureRule = {
  code: DesktopManagedAgentFailureCode;
  pattern: RegExp;
  message: string;
};

const BLOCKING_FAILURES: FailureRule[] = [
  {
    code: "quota_exhausted",
    pattern: /(?:usage|spend|credit)\s+limit|quota\s+(?:exhausted|reached)|(?:credits?|balance)\s+(?:exhausted|depleted)/i,
    message: "The provider usage limit was reached. Change the model or quota settings, then retry.",
  },
  {
    code: "authentication_required",
    pattern: /(?:not authenticated|authentication required|unauthorized|invalid api key|sign[ -]?in required|log[ -]?in required)/i,
    message: "The provider needs authentication. Sign in again, then retry.",
  },
  {
    code: "model_unavailable",
    pattern: /(?:model .*?(?:not found|unavailable|unsupported)|unknown model|invalid model)/i,
    message: "The selected model is unavailable. Choose another model, then retry.",
  },
  {
    code: "configuration_error",
    pattern: /(?:missing|invalid) (?:configuration|config|setting)|provider is not configured/i,
    message: "The provider configuration needs attention. Update it, then retry.",
  },
];

export function managedAgentFailure(input: {
  error: string | null | undefined;
  eventId?: string | null;
  occurredAt: string;
}): DesktopManagedAgentFailure {
  const rawError = String(input.error || "The provider turn failed.").trim();
  const blocking = BLOCKING_FAILURES.find((rule) => rule.pattern.test(rawError));
  return {
    code: blocking?.code ?? "provider_error",
    message: blocking?.message ?? "The provider could not complete this turn. LetAgents will retry on the next room event.",
    retryable: !blocking,
    eventId: input.eventId ?? null,
    occurredAt: input.occurredAt,
  };
}

export function managedAgentFailureRoomMessage(input: {
  displayName: string;
  failure: DesktopManagedAgentFailure;
}): string {
  return `${input.displayName} could not reply: ${input.failure.message}`;
}

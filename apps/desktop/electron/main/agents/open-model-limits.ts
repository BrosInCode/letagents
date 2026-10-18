import { assertValidOpenModelBaseUrl } from "./open-model-settings.js";
import { SUPERVISED_OPEN_MODEL_OUTPUT_TOKEN_LIMIT } from "./opencode-launch-contract.js";

export type OpenModelLimits = { context: number; output: number };

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Only the selected endpoint's exact model can supply limits; aliases are not interchangeable. */
export async function resolveOpenModelLimits(
  input: { baseUrl: string; model: string; apiKey: string | null; contextWindow?: number | null },
  fetchModel: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<OpenModelLimits> {
  const limits = (context: number, output = SUPERVISED_OPEN_MODEL_OUTPUT_TOKEN_LIMIT): OpenModelLimits => ({
    context, output: Math.min(output, SUPERVISED_OPEN_MODEL_OUTPUT_TOKEN_LIMIT, Math.max(1, Math.floor(context / 4))),
  });
  if (input.contextWindow != null) {
    if (!positiveInteger(input.contextWindow) || input.contextWindow < 2) throw new Error("The model context window must be a whole number of at least 2 tokens.");
    return limits(input.contextWindow);
  }
  assertValidOpenModelBaseUrl(input.baseUrl);
  const url = new URL(input.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  try {
    const response = await fetchModel(url.href, {
      headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
      signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (response.ok) {
      const body = await response.json() as { data?: Array<Record<string, unknown>> };
      const model = Array.isArray(body.data) ? body.data.find((item) => item?.id === input.model) : undefined;
      const top = model?.top_provider as Record<string, unknown> | undefined;
      const context = positiveInteger(model?.context_length) ?? positiveInteger(model?.max_model_len)
        ?? positiveInteger(model?.context_window) ?? positiveInteger(top?.context_length);
      const effectiveContext = context && Math.min(context, positiveInteger(top?.context_length) ?? context);
      if (effectiveContext && effectiveContext > 1) return limits(effectiveContext,
        positiveInteger(top?.max_completion_tokens) ?? positiveInteger(model?.max_output_tokens) ?? SUPERVISED_OPEN_MODEL_OUTPUT_TOKEN_LIMIT);
    }
  } catch {
    // Endpoint errors can contain credentials. Keep the setup error actionable and local.
  }
  throw new Error("The model endpoint did not provide a context window for this model. Set its context window in Open Model settings, save it as the default model, and try again.");
}

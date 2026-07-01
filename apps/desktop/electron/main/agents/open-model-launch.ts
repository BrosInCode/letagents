import type { StoredOpenModelSettings } from "./open-model-settings.js";
import { assertValidOpenModelBaseUrl, isOpenModelConfigured } from "./open-model-settings.js";

/**
 * The API key is handed to the spawned Codex app-server through this dedicated
 * env var (via Codex's `env_key` provider setting) so the key never appears in
 * launch args or in the user's global Codex config.
 */
export const OPEN_MODEL_API_KEY_ENV = "LETAGENTS_OPEN_MODEL_API_KEY";

const OPEN_MODEL_PROVIDER_KEY = "letagents_open_model";

export interface OpenModelCodexLaunch {
  configOverrides: string[];
  env: Record<string, string>;
}

/**
 * Builds the Codex `-c` config overrides that point a dedicated app-server at
 * the user's OpenAI-compatible endpoint (OpenRouter, vLLM, Ollama, ...). Values
 * are JSON-encoded because Codex parses `-c key=value` values as TOML.
 */
export function openModelCodexLaunch(settings: StoredOpenModelSettings): OpenModelCodexLaunch {
  if (!isOpenModelConfigured(settings)) {
    throw new Error("Configure a model endpoint and model before starting an open model agent.");
  }
  assertValidOpenModelBaseUrl(settings.baseUrl);

  const configOverrides = [
    `model=${JSON.stringify(settings.model)}`,
    `model_provider="${OPEN_MODEL_PROVIDER_KEY}"`,
    `model_providers.${OPEN_MODEL_PROVIDER_KEY}.name="LetAgents Open Model"`,
    `model_providers.${OPEN_MODEL_PROVIDER_KEY}.base_url=${JSON.stringify(settings.baseUrl)}`,
    `model_providers.${OPEN_MODEL_PROVIDER_KEY}.wire_api="chat"`,
  ];

  const env: Record<string, string> = {};
  if (settings.apiKey) {
    configOverrides.push(
      `model_providers.${OPEN_MODEL_PROVIDER_KEY}.env_key="${OPEN_MODEL_API_KEY_ENV}"`,
    );
    env[OPEN_MODEL_API_KEY_ENV] = settings.apiKey;
  }

  return { configOverrides, env };
}

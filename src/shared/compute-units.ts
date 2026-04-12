/**
 * Compute Unit (CU) normalization for cross-model token billing.
 *
 * 1 CU ≈ 1 Claude Haiku 3.5 input token.
 * More expensive models cost more CU per raw token.
 *
 * Used by the rental metering system to normalize token usage
 * across different AI models so the marketplace is comparable.
 */

export interface CURate {
  /** CU per input token */
  input: number;
  /** CU per output token */
  output: number;
}

/**
 * Conversion rates from raw tokens → Compute Units.
 * Key = normalized model identifier (lowercase, dashes).
 *
 * To add a new model: add an entry here + update the CU_MODEL_DISPLAY_NAMES map.
 */
export const CU_CONVERSION: Record<string, CURate> = {
  "claude-haiku-3-5": { input: 1, output: 1 },
  "claude-sonnet-4": { input: 3, output: 3 },
  "claude-opus-4": { input: 10, output: 10 },
  "claude-opus-4-6": { input: 15, output: 15 },
  "gpt-4o": { input: 3, output: 4 },
  "gpt-4-1": { input: 8, output: 12 },
  "o3": { input: 12, output: 16 },
  "gemini-2-5-pro": { input: 5, output: 7 },
};

/** Human-readable display names for model identifiers. */
export const CU_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-haiku-3-5": "Claude Haiku 3.5",
  "claude-sonnet-4": "Claude Sonnet 4",
  "claude-opus-4": "Claude Opus 4",
  "claude-opus-4-6": "Claude Opus 4.6",
  "gpt-4o": "GPT-4o",
  "gpt-4-1": "GPT-4.1",
  "o3": "o3",
  "gemini-2-5-pro": "Gemini 2.5 Pro",
};

/** All known model identifiers. */
export const KNOWN_MODELS = Object.keys(CU_CONVERSION) as readonly string[];

/**
 * Convert raw token counts into normalized Compute Units.
 *
 * Unknown models default to 1:1 (Haiku equivalent) to avoid
 * blocking new models before the table is updated.
 */
export function tokensToComputeUnits(
  model: string,
  tokensInput: number,
  tokensOutput: number
): number {
  const rates = CU_CONVERSION[model] ?? { input: 1, output: 1 };
  return tokensInput * rates.input + tokensOutput * rates.output;
}

/**
 * Get the CU rate for a model, or null if unknown.
 */
export function getModelCURate(model: string): CURate | null {
  return CU_CONVERSION[model] ?? null;
}

/**
 * Return the display name for a model identifier.
 */
export function getModelDisplayName(model: string): string {
  return CU_MODEL_DISPLAY_NAMES[model] ?? model;
}

/**
 * Check if a model identifier is recognized.
 */
export function isKnownModel(model: string): boolean {
  return model in CU_CONVERSION;
}

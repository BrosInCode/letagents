/**
 * Agent fingerprint verification for rental listings.
 *
 * When a provider creates a listing, we attempt to verify that their
 * claimed model and IDE match their actual agent identity. The verification
 * is best-effort — some agents may not expose their model in their labels.
 *
 * Pure TypeScript — no Express/Node dependencies.
 */

import type { RentalIdeLabel } from "./rental.js";

// ─── IDE Fingerprint Patterns ────────────────────────────────

/** Map of IDE labels to patterns that appear in agent actor labels. */
const IDE_FINGERPRINT_PATTERNS: Record<string, string[]> = {
  antigravity: ["antigravity", "Antigravity"],
  codex: ["codex", "Codex"],
  cursor: ["cursor", "Cursor"],
  "claude-code": ["claude-code", "Claude Code", "claude code"],
  windsurf: ["windsurf", "Windsurf"],
};

/** Map of model IDs to patterns that appear in user-agent or headers. */
const MODEL_FINGERPRINT_PATTERNS: Record<string, string[]> = {
  "claude-haiku-3-5": ["haiku", "claude-3-5-haiku", "claude-haiku", "haiku 3.5"],
  "claude-sonnet-4": ["sonnet-4", "claude-sonnet-4", "sonnet 4", "sonnet"],
  "claude-opus-4": ["opus-4", "claude-opus-4", "opus 4"],
  "claude-opus-4-6": ["opus-4-6", "opus-4.6", "claude-opus-4-6", "opus 4.6", "opus 4-6"],
  "gpt-4o": ["gpt-4o", "gpt 4o"],
  "gpt-4-1": ["gpt-4-1", "gpt-4.1", "gpt 4.1"],
  "o3": ["o3"],
  "gemini-2-5-pro": ["gemini-2-5-pro", "gemini-2.5-pro", "gemini 2.5 pro", "gemini"],
};

// ─── Verification Results ────────────────────────────────────

export interface FingerprintResult {
  model_verified: boolean;
  ide_verified: boolean;
  model_match_source: string | null; // What matched, e.g. "actor_label"
  ide_match_source: string | null;
  confidence: "high" | "medium" | "low" | "none";
}

/**
 * Verify an agent's claimed model and IDE against observable signals.
 *
 * @param claimedModel - The model the provider claims (e.g. "claude-opus-4-6")
 * @param claimedIde - The IDE the provider claims (e.g. "antigravity")
 * @param signals - Observable signals from the agent's presence
 */
export function verifyAgentFingerprint(
  claimedModel: string,
  claimedIde: string,
  signals: {
    actor_label?: string | null;
    ide_label?: string | null;
    display_name?: string | null;
    user_agent?: string | null;
  }
): FingerprintResult {
  let model_verified = false;
  let ide_verified = false;
  let model_match_source: string | null = null;
  let ide_match_source: string | null = null;

  // --- IDE verification ---
  const idePatterns = IDE_FINGERPRINT_PATTERNS[claimedIde] || [];

  // Check ide_label first (most reliable)
  if (signals.ide_label) {
    const normalized = signals.ide_label.toLowerCase();
    if (idePatterns.some(p => normalized.includes(p.toLowerCase()))) {
      ide_verified = true;
      ide_match_source = "ide_label";
    }
  }

  // Fall back to actor_label
  if (!ide_verified && signals.actor_label) {
    const normalized = signals.actor_label.toLowerCase();
    if (idePatterns.some(p => normalized.includes(p.toLowerCase()))) {
      ide_verified = true;
      ide_match_source = "actor_label";
    }
  }

  // --- Model verification ---
  // Model detection is harder — most agents don't expose their model in labels.
  // We check user_agent (if available) and actor_label as best-effort.
  const modelPatterns = MODEL_FINGERPRINT_PATTERNS[claimedModel] || [];

  if (signals.user_agent) {
    const normalized = signals.user_agent.toLowerCase();
    if (modelPatterns.some(p => normalized.includes(p.toLowerCase()))) {
      model_verified = true;
      model_match_source = "user_agent";
    }
  }

  if (!model_verified && signals.actor_label) {
    const normalized = signals.actor_label.toLowerCase();
    if (modelPatterns.some(p => normalized.includes(p.toLowerCase()))) {
      model_verified = true;
      model_match_source = "actor_label";
    }
  }

  if (!model_verified && signals.display_name) {
    const normalized = signals.display_name.toLowerCase();
    if (modelPatterns.some(p => normalized.includes(p.toLowerCase()))) {
      model_verified = true;
      model_match_source = "display_name";
    }
  }

  // --- Confidence ---
  let confidence: FingerprintResult["confidence"];
  if (model_verified && ide_verified) {
    confidence = "high";
  } else if (ide_verified) {
    confidence = "medium";
  } else if (model_verified) {
    confidence = "low";
  } else {
    confidence = "none";
  }

  return {
    model_verified,
    ide_verified,
    model_match_source,
    ide_match_source,
    confidence,
  };
}

/**
 * Check if a claimed IDE matches a known LetAgents IDE label.
 */
export function isKnownIdeLabel(ide: string): boolean {
  return ide in IDE_FINGERPRINT_PATTERNS;
}

/**
 * Check if a claimed model matches a known model fingerprint.
 */
export function isKnownModelFingerprint(model: string): boolean {
  return model in MODEL_FINGERPRINT_PATTERNS;
}

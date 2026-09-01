import { z } from "zod";

export const lifecycleAuthorityModeSchema = z.enum(["legacy", "typed_shadow", "typed"]);
export type LifecycleAuthorityMode = z.output<typeof lifecycleAuthorityModeSchema>;

export const lifecycleAuthorityProviderSchema = z.enum(["codex", "claude-code", "cursor", "open-model"]);
export type LifecycleAuthorityProvider = z.output<typeof lifecycleAuthorityProviderSchema>;

const RELEASE_AUTHORITY = Object.freeze({
  codex: "typed_shadow",
  "claude-code": "typed_shadow",
  cursor: "typed_shadow",
  "open-model": "typed_shadow",
} satisfies Record<LifecycleAuthorityProvider, LifecycleAuthorityMode>);

/** Closed release policy. Authority cannot vary by config, environment, or manifest state. */
export function lifecycleAuthorityModeForProvider(provider: LifecycleAuthorityProvider): LifecycleAuthorityMode {
  return RELEASE_AUTHORITY[provider];
}

export function isTypedCaptureAuthority(mode: unknown): mode is "typed_shadow" | "typed" {
  return mode === "typed_shadow" || mode === "typed";
}

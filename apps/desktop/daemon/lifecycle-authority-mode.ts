import { z } from "zod";

export const lifecycleAuthorityModeSchema = z.enum(["legacy", "typed_shadow", "typed"]);
export type LifecycleAuthorityMode = z.output<typeof lifecycleAuthorityModeSchema>;

export const lifecycleAuthorityProviderSchema = z.enum(["codex", "claude-code", "cursor", "open-model"]);
export type LifecycleAuthorityProvider = z.output<typeof lifecycleAuthorityProviderSchema>;

const RELEASE_AUTHORITY = Object.freeze({
  cursor: "typed_shadow",
} satisfies Record<Exclude<LifecycleAuthorityProvider, "codex" | "claude-code" | "open-model">, LifecycleAuthorityMode>);

/** Closed release policy. Authority varies only by provider and durable delivery shape. */
export function lifecycleAuthorityModeForProvider(
  provider: LifecycleAuthorityProvider,
  deliveryMode: "mcp_polling" | "desktop_events" | "daemon_inbox",
): LifecycleAuthorityMode {
  if (provider === "codex" || provider === "claude-code" || provider === "open-model") {
    return deliveryMode === "daemon_inbox" ? "typed" : "typed_shadow";
  }
  return RELEASE_AUTHORITY[provider];
}

export function isTypedCaptureAuthority(mode: unknown): mode is "typed_shadow" | "typed" {
  return mode === "typed_shadow" || mode === "typed";
}

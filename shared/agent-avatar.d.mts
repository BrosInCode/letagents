export const AGENT_AVATAR_CHARACTERS: readonly ["orbit", "prism", "tide", "spark", "bloom", "beacon", "fern", "pip", "pebble", "moss", "wren", "ember", "cosmo", "nimbus", "comet", "lune", "ripple", "vesper"];
export const AGENT_AVATAR_COLORS: readonly ["sage", "blue", "lilac", "rose", "amber", "graphite", "pearl"];
export type AgentAvatarCharacter = typeof AGENT_AVATAR_CHARACTERS[number];
export type AgentAvatarColor = typeof AGENT_AVATAR_COLORS[number];
export type AgentAvatar =
  | { kind: "character"; character: AgentAvatarCharacter; color: AgentAvatarColor }
  | { kind: "initials"; color: AgentAvatarColor }
  | { kind: "image"; dataUrl: string };
export const AGENT_AVATAR_IMAGE_MAX_BYTES = 32768;
export const AGENT_AVATAR_IMAGE_MAX_DIMENSION = 96;

export function normalizeAgentAvatar(value: unknown): AgentAvatar | null;

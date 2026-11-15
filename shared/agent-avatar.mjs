/** Presentation only. Never use an avatar or display name as a routing identity. */
export const AGENT_AVATAR_CHARACTERS = ["orbit", "prism", "tide", "spark", "bloom", "beacon", "fern", "pip", "pebble", "moss", "wren", "ember", "cosmo", "nimbus", "comet", "lune", "ripple", "vesper"];
export const AGENT_AVATAR_COLORS = ["sage", "blue", "lilac", "rose", "amber", "graphite", "pearl"];
export const AGENT_AVATAR_IMAGE_MAX_BYTES = 32_768;
export const AGENT_AVATAR_IMAGE_MAX_DIMENSION = 96;

/** Only normalized small PNGs, never a remote URL, SVG, or executable image format. */
function validPng(value) {
  if (typeof value !== "string" || value.length > 43_714 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  let data;
  try { data = atob(value.slice(22)); } catch { return false; }
  if (data.length > AGENT_AVATAR_IMAGE_MAX_BYTES || !data.startsWith("\x89PNG\r\n\x1a\n")) return false;
  const uint = (offset) => ((data.charCodeAt(offset) * 0x1000000) + (data.charCodeAt(offset + 1) << 16) + (data.charCodeAt(offset + 2) << 8) + data.charCodeAt(offset + 3));
  let offset = 8, pixels = false;
  while (offset + 12 <= data.length) {
    const length = uint(offset), type = data.slice(offset + 4, offset + 8);
    if (offset + 12 + length > data.length) return false;
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = uint(offset + 8), height = uint(offset + 12);
      if (width < 1 || height < 1 || width > AGENT_AVATAR_IMAGE_MAX_DIMENSION || height > AGENT_AVATAR_IMAGE_MAX_DIMENSION) return false;
    } else if (type === "IHDR" || type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (type === "IDAT") pixels = true;
    if (type === "IEND") return pixels && length === 0 && offset + 12 === data.length;
    offset += 12 + length;
  }
  return false;
}

/** Missing/invalid persisted presentation degrades to the existing provider avatar. */
export function normalizeAgentAvatar(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const avatar = value;
  if (avatar.kind === "image") return validPng(avatar.dataUrl) ? { kind: "image", dataUrl: avatar.dataUrl } : null;
  if (!AGENT_AVATAR_COLORS.includes(avatar.color)) return null;
  const color = avatar.color;
  if (avatar.kind === "initials") return { kind: "initials", color };
  if (avatar.kind === "character" && AGENT_AVATAR_CHARACTERS.includes(avatar.character)) return { kind: "character", character: avatar.character, color };
  return null;
}

import crypto from "crypto";
import { repositoryRoomName } from "../../../shared/project-room-name.mjs";

const ADJECTIVES = [
  "amber",
  "autumn",
  "brisk",
  "calm",
  "cedar",
  "clear",
  "copper",
  "crisp",
  "dawn",
  "ember",
  "fern",
  "frost",
  "golden",
  "granite",
  "harbor",
  "hollow",
  "indigo",
  "ivory",
  "jade",
  "juniper",
  "kind",
  "lively",
  "lunar",
  "maple",
  "meadow",
  "misty",
  "morrow",
  "moss",
  "noble",
  "north",
  "oak",
  "olive",
  "opal",
  "pearl",
  "pine",
  "plains",
  "quiet",
  "rapid",
  "river",
  "royal",
  "sable",
  "sage",
  "scarlet",
  "shore",
  "silver",
  "sky",
  "solar",
  "spring",
  "stone",
  "storm",
  "summer",
  "sunlit",
  "swift",
  "tidal",
  "timber",
  "verdant",
  "warm",
  "west",
  "wild",
  "willow",
  "winter",
];

const NOUNS = [
  "anchor",
  "badger",
  "bay",
  "bear",
  "brook",
  "canyon",
  "cloud",
  "comet",
  "creek",
  "crest",
  "delta",
  "dune",
  "falcon",
  "field",
  "firefly",
  "fjord",
  "forest",
  "fox",
  "garden",
  "glade",
  "grove",
  "harbor",
  "hawk",
  "hill",
  "isle",
  "lagoon",
  "lake",
  "lantern",
  "leaf",
  "lynx",
  "marsh",
  "mesa",
  "moon",
  "otter",
  "owl",
  "peak",
  "pine",
  "rain",
  "raven",
  "reef",
  "ridge",
  "river",
  "rook",
  "shore",
  "sparrow",
  "spring",
  "star",
  "stone",
  "summit",
  "sun",
  "thicket",
  "trail",
  "valley",
  "vista",
  "wave",
  "wharf",
  "wind",
  "wolf",
  "wood",
  "wren",
];

export function generateRoomDisplayName(roomId: string): string {
  const digest = crypto.createHash("sha256").update(roomId).digest();
  const adjective = ADJECTIVES[digest[0] % ADJECTIVES.length];
  const noun = NOUNS[digest[1] % NOUNS.length];
  return `${adjective}-${noun}`;
}

export function defaultRoomDisplayName(roomId: string): string {
  return repositoryRoomName(roomId) || generateRoomDisplayName(roomId);
}

/** Read old generated project labels without rewriting room IDs or custom names. */
export function resolveRoomDisplayName(roomId: string, displayName: string, kind: string): string {
  const repositoryName = kind === "main" ? repositoryRoomName(roomId) : null;
  return repositoryName && displayName === generateRoomDisplayName(roomId)
    ? repositoryName
    : displayName;
}

export function normalizeRoomDisplayName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 64) {
    throw new Error("display_name must be between 2 and 64 characters");
  }
  return trimmed;
}

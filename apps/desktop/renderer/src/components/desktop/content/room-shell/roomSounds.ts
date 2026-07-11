import { play, type SoundName } from "cuelume";

export type RoomSoundKind = "send" | "notification";

export const roomSoundByKind = {
  send: "release",
  notification: "chime",
} as const satisfies Record<RoomSoundKind, SoundName>;

export function playRoomInteractionSound(
  kind: RoomSoundKind,
  playSound: (sound: SoundName) => void = play,
): void {
  playSound(roomSoundByKind[kind]);
}

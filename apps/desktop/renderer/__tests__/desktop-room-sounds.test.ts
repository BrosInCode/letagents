import assert from "node:assert/strict";
import test from "node:test";

import {
  playRoomInteractionSound,
  roomSoundByKind,
} from "../src/components/desktop/content/room-shell/roomSounds";

test("desktop room send and notification feedback use distinct Cuelume sounds", () => {
  const played: string[] = [];

  playRoomInteractionSound("send", (sound) => played.push(sound));
  playRoomInteractionSound("notification", (sound) => played.push(sound));

  assert.deepEqual(roomSoundByKind, {
    send: "release",
    notification: "chime",
  });
  assert.deepEqual(played, ["release", "chime"]);
});

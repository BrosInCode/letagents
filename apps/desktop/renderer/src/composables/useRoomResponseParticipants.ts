import { shallowRef, watch } from "vue";
import { RoomResponseParticipants, roomResponseParticipantsKey } from "../domain/room-response-participants";

export function useRoomResponseParticipants(input: () => Parameters<RoomResponseParticipants["update"]>[0]) {
  const tracker = new RoomResponseParticipants();
  const participants = shallowRef<ReturnType<RoomResponseParticipants["update"]>>([]);
  // Watch only the fields the tracker reads (a string key), not the whole input with
  // every message deep-traversed. The tracker still gets the live input object.
  watch(() => roomResponseParticipantsKey(input()), () => { participants.value = tracker.update(input()); }, { immediate: true });
  return participants;
}

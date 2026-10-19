import { shallowRef, watch } from "vue";
import { RoomResponseParticipants } from "../domain/room-response-participants";

export function useRoomResponseParticipants(input: () => Parameters<RoomResponseParticipants["update"]>[0]) {
  const tracker = new RoomResponseParticipants();
  const participants = shallowRef<ReturnType<RoomResponseParticipants["update"]>>([]);
  watch(input, value => { participants.value = tracker.update(value); }, { immediate: true, deep: true });
  return participants;
}

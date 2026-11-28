import { inject, provide, ref, type InjectionKey, type Ref } from "vue";

const leavingKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol("room-loader-leaving");

/**
 * The hand-off from the room's loading or access screen to the room itself.
 * App.vue wraps that screen in `<Transition :name="…" @before-leave @after-leave>`.
 *
 * 1. The room arrives: the screen is leaving, and the room is already drawn
 *    in the same place underneath.
 * 2. `beforeLeave` pins the leaving screen where it is (fixed, same box), so it
 *    lies over the room instead of being pushed down by it.
 * 3. `leaving` turns true: the ink loader lets its mark go as smoke
 *    (InkRoomLoader), and the CSS transition fades the screen out over the room.
 *
 * When the screen leaves for something other than a room (My work, Settings),
 * `arriving()` is false: nothing is pinned and the screen goes at once.
 */
export function provideRoomLoaderHandOff(arriving: () => boolean) {
  const leaving = ref(false);
  provide(leavingKey, leaving);
  return {
    beforeLeave(element: Element): void {
      if (!arriving() || !(element instanceof HTMLElement)) return;
      const box = element.getBoundingClientRect();
      // Keep a higher layer it already has (the first-load veil sits over everything).
      const ownLayer = Number.parseInt(getComputedStyle(element).zIndex, 10);
      Object.assign(element.style, {
        position: "fixed",
        top: `${box.top}px`,
        left: `${box.left}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        margin: "0",
        zIndex: String(Number.isFinite(ownLayer) && ownLayer > 40 ? ownLayer : 40),
        pointerEvents: "none",
      });
      leaving.value = true;
    },
    afterLeave(): void {
      leaving.value = false;
    },
  };
}

/** True while the screen around this component fades out over the arriving room. */
export function useRoomLoaderLeaving(): Readonly<Ref<boolean>> {
  return inject(leavingKey, ref(false));
}

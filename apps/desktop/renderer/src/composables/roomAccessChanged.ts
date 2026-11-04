import type { InjectionKey } from "vue";

/** Asks the app to check the open room again after a change to your own access, such as Leave. */
export const roomAccessChangedKey: InjectionKey<() => void> = Symbol("roomAccessChanged");

import type { FunctionalComponent, InjectionKey } from "vue";

/**
 * The open thread under its root message in the timeline. The timeline
 * provides it, and the active thread root renders it. A slot passed from the
 * timeline's row loop would make every row redraw with the list; this does not.
 */
export const inlineThreadKey: InjectionKey<FunctionalComponent> = Symbol("inline-thread");

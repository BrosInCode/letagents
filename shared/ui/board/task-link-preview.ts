import { inject, type InjectionKey } from 'vue';

export type TaskLinkPreview = (id: string, anchor: HTMLElement, keyboard: boolean, onNavigate?: () => void) => void;
export const taskLinkPreviewKey: InjectionKey<TaskLinkPreview> = Symbol('task-link-preview');
export function useTaskLinkPreview() { return inject(taskLinkPreviewKey, null); }

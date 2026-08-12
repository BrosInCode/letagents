import { ref } from "vue";

export type DesktopActionToastState = "error" | "info" | "success";

export type DesktopActionToast = {
  id: number;
  message: string;
  state: DesktopActionToastState;
};

const actionToasts = ref<DesktopActionToast[]>([]);
let nextActionToastId = 1;

export function useDesktopActionToasts() {
  function pushActionToast(
    message: string,
    state: DesktopActionToastState = "info",
    timeoutMs = 4200,
  ): void {
    const id = nextActionToastId++;
    actionToasts.value = [...actionToasts.value.slice(-2), { id, message, state }];
    window.setTimeout(() => dismissActionToast(id), timeoutMs);
  }

  function dismissActionToast(id: number): void {
    actionToasts.value = actionToasts.value.filter((toast) => toast.id !== id);
  }

  return { actionToasts, dismissActionToast, pushActionToast };
}

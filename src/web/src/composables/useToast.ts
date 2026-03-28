import { ref, readonly } from 'vue'

interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
  duration: number
}

const toasts = ref<Toast[]>([])
let nextId = 0

export function useToast() {
  function show(message: string, type: Toast['type'] = 'info', duration = 3000) {
    const id = nextId++
    toasts.value.push({ id, message, type, duration })

    if (duration > 0) {
      setTimeout(() => dismiss(id), duration)
    }
  }

  function dismiss(id: number) {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }

  function success(message: string, duration?: number) {
    show(message, 'success', duration)
  }

  function error(message: string, duration?: number) {
    show(message, 'error', duration ?? 5000)
  }

  function info(message: string, duration?: number) {
    show(message, 'info', duration)
  }

  return {
    toasts: readonly(toasts),
    show,
    dismiss,
    success,
    error,
    info,
  }
}

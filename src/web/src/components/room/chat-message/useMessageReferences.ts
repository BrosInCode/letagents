import { computed, ref } from 'vue'
import {
  type RoomMessage,
  parseAgentIdentity,
} from '@/composables/useRoom'

const MESSAGE_REF_TOKEN_SELECTOR = '.message-ref-token'
const POPOVER_MAX_WIDTH = 320
const POPOVER_MARGIN = 12

export interface MessageReferencePreview {
  id: string
  preview: string
  loaded: boolean
}

export function useMessageReferences(input: {
  messageReferences: () => ReadonlyMap<string, RoomMessage> | undefined
  tooltipId: string
}) {
  const selectedReferenceId = ref<string | null>(null)
  const referenceDialogOpen = ref(false)
  const referenceTrigger = ref<HTMLElement | null>(null)
  const hoveredReference = ref<MessageReferencePreview | null>(null)
  const hoverPopoverStyle = ref<Record<string, string>>({})
  const hoverToken = ref<HTMLElement | null>(null)
  const focusToken = ref<HTMLElement | null>(null)
  const describedToken = ref<HTMLElement | null>(null)

  const selectedReferenceMessage = computed(() =>
    selectedReferenceId.value
      ? input.messageReferences()?.get(selectedReferenceId.value) || null
      : null
  )

  function findReferenceToken(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null
    const token = target.closest(MESSAGE_REF_TOKEN_SELECTOR)
    return token instanceof HTMLElement ? token : null
  }

  function getReferencePreview(messageId: string): MessageReferencePreview {
    const message = input.messageReferences()?.get(messageId) || null
    if (!message) {
      return {
        id: messageId,
        preview: 'Message is not loaded in this transcript window.',
        loaded: false,
      }
    }

    const sender = parseAgentIdentity(message.sender).displayName || message.sender || 'Unknown'
    const text = (message.text || '').replace(/\s+/g, ' ').trim()
    const preview = text.length > 180 ? `${text.slice(0, 177)}...` : text
    return {
      id: messageId,
      preview: preview ? `${sender}: ${preview}` : `${sender}: empty message`,
      loaded: true,
    }
  }

  function setDescribedToken(token: HTMLElement | null) {
    if (describedToken.value && describedToken.value !== token) {
      describedToken.value.removeAttribute('aria-describedby')
    }
    describedToken.value = token
    if (token) {
      token.setAttribute('aria-describedby', input.tooltipId)
    }
  }

  function updateReferencePopover() {
    const token = focusToken.value || hoverToken.value
    if (!token) {
      hoveredReference.value = null
      setDescribedToken(null)
      return
    }

    const messageId = token.dataset.messageRefId || ''
    if (!messageId) {
      hoveredReference.value = null
      setDescribedToken(null)
      return
    }

    const rect = token.getBoundingClientRect()
    const popoverWidth = Math.min(POPOVER_MAX_WIDTH, Math.max(0, window.innerWidth - POPOVER_MARGIN * 2))
    const halfWidth = popoverWidth / 2
    const minLeft = POPOVER_MARGIN + halfWidth
    const maxLeft = window.innerWidth - POPOVER_MARGIN - halfWidth
    const center = rect.left + rect.width / 2
    const left = minLeft > maxLeft ? window.innerWidth / 2 : Math.min(Math.max(center, minLeft), maxLeft)
    const showBelow = rect.top < 150

    hoveredReference.value = getReferencePreview(messageId)
    hoverPopoverStyle.value = {
      left: `${left}px`,
      top: `${showBelow ? rect.bottom + 10 : rect.top - 10}px`,
      '--message-ref-popover-transform': showBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
    }
    setDescribedToken(token)
  }

  function closeReferencePopover() {
    hoverToken.value = null
    focusToken.value = null
    hoveredReference.value = null
    setDescribedToken(null)
  }

  function openReferenceDialog(token: HTMLElement) {
    const messageId = token.dataset.messageRefId || ''
    if (!messageId) return
    referenceTrigger.value = token
    selectedReferenceId.value = messageId
    referenceDialogOpen.value = true
    closeReferencePopover()
  }

  function closeReferenceDialog() {
    referenceDialogOpen.value = false
  }

  function handleReferenceClick(event: MouseEvent) {
    const token = findReferenceToken(event.target)
    if (!token) return
    event.preventDefault()
    event.stopPropagation()
    openReferenceDialog(token)
  }

  function handleReferenceMouseOver(event: MouseEvent) {
    const token = findReferenceToken(event.target)
    if (!token) return
    hoverToken.value = token
    updateReferencePopover()
  }

  function handleReferenceMouseOut(event: MouseEvent) {
    const token = findReferenceToken(event.target)
    if (!token || hoverToken.value !== token) return
    if (event.relatedTarget instanceof Node && token.contains(event.relatedTarget)) return
    hoverToken.value = null
    updateReferencePopover()
  }

  function handleReferenceFocusIn(event: FocusEvent) {
    const token = findReferenceToken(event.target)
    if (!token) return
    focusToken.value = token
    updateReferencePopover()
  }

  function handleReferenceFocusOut(event: FocusEvent) {
    const token = findReferenceToken(event.target)
    if (!token || focusToken.value !== token) return
    focusToken.value = null
    updateReferencePopover()
  }

  return {
    selectedReferenceId,
    selectedReferenceMessage,
    referenceDialogOpen,
    referenceTrigger,
    hoveredReference,
    hoverPopoverStyle,
    closeReferenceDialog,
    handleReferenceClick,
    handleReferenceMouseOver,
    handleReferenceMouseOut,
    handleReferenceFocusIn,
    handleReferenceFocusOut,
  }
}

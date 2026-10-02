import { computed, inject, onScopeDispose, provide, shallowRef, watch, type Ref } from 'vue'
import { createMessageLinkPreviewStore } from '../../../../shared/message-link-preview-store.mjs'
import { eligibleLinkPreviewReferences, normalizePreviewRepository, type MessageLinkPreviewsResponse } from '../../../../shared/message-link-previews.mjs'
import { apiFetch, roomPath } from './room/api'
import { useAuth } from './useAuth'

const invalidation = shallowRef<{ room: string } | null>(null)
export function publishMessageLinkPreviewInvalidation(room: string): void { invalidation.value = { room } }
export function useRoomMessageLinkPreviews(room: Readonly<Ref<string>>, repository: Readonly<Ref<string | null>>) {
  const auth = useAuth()
  const revision = shallowRef(0)
  const contextKey = computed(() => JSON.stringify([room.value, repository.value, auth.isSignedIn.value, auth.user.value?.login]))
  const store = createMessageLinkPreviewStore({
    load: async (references): Promise<MessageLinkPreviewsResponse> => {
      const expectedRepository = normalizePreviewRepository(repository.value)
      const result: MessageLinkPreviewsResponse = await apiFetch(`${roomPath(room.value)}/messages/link-previews`, {
        method: 'POST', body: JSON.stringify({ references }),
      })
      return { ...result, previews: result.previews.filter(preview => expectedRepository !== null && normalizePreviewRepository(preview.repository) === expectedRepository) }
    },
    onChange: () => { revision.value++ },
  })
  watch(contextKey, () => store.reset(), { flush: 'sync' })
  watch(invalidation, (value) => { if (value?.room === room.value) void store.refresh() })
  onScopeDispose(() => store.reset())
  return {
    revision, contextKey,
    previewsFor(id: string) { void revision.value; return store.get(id) },
    track(message: { id: string; urls: string[] }) {
      if (!room.value || !/^msg_[1-9]\d*$/.test(message.id)) return () => {}
      return store.track({ id: message.id, references: eligibleLinkPreviewReferences(message.urls, repository.value) })
    },
  }
}
const KEY = Symbol('message-link-previews')
type Context = ReturnType<typeof useRoomMessageLinkPreviews>
export function provideRoomMessageLinkPreviews(context: Context): void { provide(KEY, context) }
export function injectRoomMessageLinkPreviews(): Context | null { return inject<Context | null>(KEY, null) }

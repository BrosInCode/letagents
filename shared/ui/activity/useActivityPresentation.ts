import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';

/** A selected tab alone is not a read: wait until its filtered rows are rendered. */
export function useActivityPresentation(
  ids: Readonly<Ref<readonly string[]>>,
  readable: Readonly<Ref<boolean>>,
  presented: (ids: readonly string[]) => void,
) {
  const mounted = ref(false);
  const visible = ref(false);
  const updateVisibility = () => { visible.value = typeof document !== 'undefined' && document.visibilityState === 'visible'; };
  onMounted(() => {
    mounted.value = true;
    updateVisibility();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', updateVisibility);
  });
  onActivated(() => { mounted.value = true; updateVisibility(); });
  onDeactivated(() => { mounted.value = false; });
  onUnmounted(() => { mounted.value = false; if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', updateVisibility); });
  watch([ids, readable, visible, mounted], () => {
    if (mounted.value && visible.value && readable.value) presented(ids.value);
  }, { flush: 'post' });
}

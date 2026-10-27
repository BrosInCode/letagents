import { defineAsyncComponent, h, type AsyncComponentLoader } from 'vue'

/** Keep inactive workspace views out of the initial chat download. */
export function asyncRoomPanel(loader: AsyncComponentLoader) {
  return defineAsyncComponent({
    loader,
    loadingComponent: () => h('div', {
      class: 'room-panel-placeholder', role: 'status',
    }, 'Loading view…'),
    errorComponent: () => h('div', {
      class: 'room-panel-placeholder', role: 'alert',
    }, 'This view could not load. Check your connection, then switch tabs to try again.'),
  })
}

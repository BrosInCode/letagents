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
    }, [
      h('p', 'This view could not load. Check your connection, then reload to try again.'),
      h('button', { type: 'button', onClick: () => window.location.reload() }, 'Reload view'),
    ]),
  })
}

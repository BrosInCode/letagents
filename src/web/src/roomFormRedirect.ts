import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router'

/**
 * The room form left the landing page for /new. Old links to it (`/?new=blank`, `/#start`)
 * still reach the form, and the Blank room tab stays selected when the link asked for it.
 */
export function roomFormRedirect(to: Pick<RouteLocationNormalized, 'path' | 'query' | 'hash'>): RouteLocationRaw | true {
  if (to.path !== '/' || (to.query.new !== 'blank' && to.hash !== '#start')) return true
  return { path: '/new', query: to.query.new === 'blank' ? { new: 'blank' } : {} }
}

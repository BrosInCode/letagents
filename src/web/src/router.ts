import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router'

const routes = [
  { path: "/inbox", name: "inbox", component: () => import("./pages/Inbox.vue") },
  { path: "/connectors", name: "connectors", component: () => import("./pages/Connectors.vue") },
  { path: "/my-work", name: "my-work", component: () => import("./pages/MyWork.vue") },
  { path: "/messages", name: "messages", component: () => import("./pages/Messages.vue") },
  {
    path: '/company/:organizationId(\\d+)',
    name: 'company-link',
    component: () => import('./pages/CompanyLink.vue'),
  },
  {
    path: '/',
    name: 'landing',
    component: () => import('./pages/Landing.vue'),
    // The room form left the landing page for /new; old links to it still land on the form.
    beforeEnter: (to: RouteLocationNormalized) => to.query.new === 'blank' || to.hash === '#start'
      ? { path: '/new', query: to.query.new === 'blank' ? { new: 'blank' } : {} }
      : true,
  },
  {
    path: '/new',
    name: 'new-room',
    component: () => import('./pages/NewRoom.vue'),
  },
  {
    path: '/ask/:token',
    name: 'ask',
    component: () => import('./pages/AskLink.vue'),
    props: true,
  },
  {
    path: '/docs',
    name: 'docs',
    component: () => import('./pages/Docs.vue'),
  },
  {
    path: '/in/:roomId(.*)',
    name: 'room',
    component: () => import('./pages/Room.vue'),
    props: true,
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, _from, savedPosition) {
    if (to.hash) {
      const navbarBottom = document.querySelector('.navbar')?.getBoundingClientRect().bottom ?? 72
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      return { el: to.hash, top: Math.max(92, navbarBottom + 20), behavior: reducedMotion ? 'instant' : 'smooth' }
    }
    if (savedPosition) {
      return savedPosition
    }
    return { top: 0 }
  },
})

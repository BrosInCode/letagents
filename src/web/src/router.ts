import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: "/connectors", name: "connectors", component: () => import("./pages/Connectors.vue") },
  { path: "/my-work", name: "my-work", component: () => import("./pages/MyWork.vue") },
  { path: "/messages", name: "messages", component: () => import("./pages/Messages.vue") },
  {
    path: '/',
    name: 'landing',
    component: () => import('./pages/Landing.vue'),
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

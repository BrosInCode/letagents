import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'landing',
    component: () => import('./pages/Landing.vue'),
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
      return { el: to.hash, behavior: 'smooth' }
    }
    if (savedPosition) {
      return savedPosition
    }
    return { top: 0 }
  },
})

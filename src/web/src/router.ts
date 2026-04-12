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
  {
    path: '/handoff',
    name: 'handoff',
    component: () => import('./pages/HandoffView.vue'),
  },
  {
    path: '/marketplace',
    name: 'marketplace',
    component: () => import('./pages/Marketplace.vue'),
  },
  {
    path: '/marketplace/listings/:id',
    name: 'listing-detail',
    component: () => import('./pages/ListingDetail.vue'),
    props: true,
  },
  {
    path: '/marketplace/create',
    name: 'listing-create',
    component: () => import('./pages/ListingCreate.vue'),
  },
  {
    path: '/rental/sessions',
    name: 'rental-sessions',
    component: () => import('./pages/RentalSessions.vue'),
  },
  {
    path: '/rental/sessions/:id',
    name: 'rental-session-detail',
    component: () => import('./pages/RentalSessionDetail.vue'),
    props: true,
  },
  {
    path: '/provider',
    name: 'provider-dashboard',
    component: () => import('./pages/ProviderDashboard.vue'),
  },
  {
    path: '/provider/notifications',
    name: 'notification-settings',
    component: () => import('./pages/NotificationSettings.vue'),
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

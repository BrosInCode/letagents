<template>
  <nav :class="['navbar', { 'navbar--scrolled': isScrolled }]">
    <RouterLink to="/" class="nav-brand">
      <div class="nav-logo">LA</div>
      <span class="nav-name">Let Agents Chat</span>
    </RouterLink>

    <div class="nav-links">
      <RouterLink
        v-for="link in sectionLinks"
        :key="link.to"
        :to="link.to"
        class="nav-link nav-section-link"
      >
        {{ link.label }}
      </RouterLink>
      <RouterLink to="/docs" class="nav-link">Docs</RouterLink>

      <div class="nav-divider" />

      <!-- Signed out -->
      <template v-if="!auth.isSignedIn.value">
        <button class="btn btn-ghost btn-sm" @click="auth.signIn()">
          <GitHubIcon :size="16" />
          Sign In
        </button>
      </template>

      <!-- Signed in -->
      <template v-else>
        <div class="nav-auth-user">
          <img
            v-if="auth.user.value?.avatar_url"
            :src="auth.user.value.avatar_url"
            :alt="auth.user.value.login"
            class="nav-avatar"
          />
          <div v-else class="nav-avatar-fallback">
            {{ auth.user.value?.login?.charAt(0)?.toUpperCase() || '?' }}
          </div>
          <span class="nav-username">{{ auth.user.value?.login }}</span>
        </div>
        <button class="nav-signout" @click="auth.signOut()">Sign Out</button>
      </template>

      <RouterLink to="/#setup" class="btn btn-primary btn-sm">
        Open a Room →
      </RouterLink>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useAuth } from '@/composables/useAuth'
import GitHubIcon from '@/components/icons/GitHubIcon.vue'

const auth = useAuth()

const sectionLinks = [
  { to: '/#setup', label: 'Setup' },
  { to: '/#features', label: 'Features' },
]

const isScrolled = ref(false)

function onScroll() {
  isScrolled.value = window.scrollY > 20
}

onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }))
onUnmounted(() => window.removeEventListener('scroll', onScroll))
</script>

<style scoped>
.navbar {
  position: fixed;
  top: 12px;
  left: 24px;
  right: 24px;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: rgba(12, 12, 12, 0.78);
  backdrop-filter: blur(24px) saturate(200%);
  -webkit-backdrop-filter: blur(24px) saturate(200%);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.03),
    0 4px 24px rgba(0, 0, 0, 0.4),
    0 1px 3px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  transition: background var(--duration-normal) var(--ease-out),
              box-shadow var(--duration-normal) var(--ease-out);
}

.navbar::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 20%;
  right: 20%;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(148, 163, 184, 0.25),
    rgba(226, 232, 240, 0.15),
    rgba(148, 163, 184, 0.25),
    transparent
  );
  border-radius: 1px;
}

.navbar--scrolled {
  background: rgba(12, 12, 12, 0.92);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.05),
    0 8px 32px rgba(0, 0, 0, 0.5);
}

/* Brand */
.nav-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
  color: var(--text);
  transition: opacity var(--duration-fast);
}

.nav-brand:hover { opacity: 0.85; }

.nav-logo {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, #e2e8f0 0%, #94a3b8 50%, #cbd5e1 100%);
  display: grid;
  place-items: center;
  font-weight: 900;
  font-size: 0.62rem;
  color: #0f172a;
  letter-spacing: 0.04em;
  box-shadow: 0 2px 8px rgba(148, 163, 184, 0.2);
  transition: transform 300ms var(--ease-out), box-shadow 300ms var(--ease-out);
}

.nav-brand:hover .nav-logo {
  transform: scale(1.06);
  box-shadow: 0 3px 12px rgba(148, 163, 184, 0.3);
}

.nav-name {
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: rgba(255, 255, 255, 0.9);
}

/* Links */
.nav-links {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nav-link {
  position: relative;
  padding: 6px 14px;
  border-radius: var(--radius-md);
  font-size: 0.82rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.45);
  text-decoration: none;
  transition: color var(--duration-normal), background var(--duration-normal);
  letter-spacing: 0.01em;
}

.nav-link::after {
  content: '';
  position: absolute;
  bottom: 2px;
  left: 50%;
  width: 0;
  height: 1.5px;
  background: linear-gradient(90deg, #94a3b8, #e2e8f0);
  border-radius: 1px;
  transform: translateX(-50%);
  transition: width var(--duration-normal) var(--ease-out);
}

.nav-link:hover {
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.04);
}

.nav-link:hover::after {
  width: 60%;
}

/* Auth */
.nav-divider {
  width: 1px;
  height: 18px;
  background: linear-gradient(180deg, transparent, rgba(255, 255, 255, 0.12), transparent);
  margin: 0 8px;
}

.nav-auth-user {
  display: flex;
  align-items: center;
  gap: 10px;
}

.nav-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.nav-avatar-fallback {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: linear-gradient(135deg, rgba(148, 163, 184, 0.2), rgba(226, 232, 240, 0.1));
  border: 1.5px solid rgba(255, 255, 255, 0.1);
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 0.58rem;
  color: var(--text);
}

.nav-username {
  font-size: 0.8rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.8);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-signout {
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.72rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.35);
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: all var(--duration-fast);
  letter-spacing: 0.01em;
}

.nav-signout:hover {
  color: rgba(255, 255, 255, 0.8);
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.04);
}

/* Buttons inline */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  border-radius: var(--radius-md);
  transition: all var(--duration-fast);
  text-decoration: none;
  white-space: nowrap;
}

.btn-sm {
  padding: 6px 14px;
  font-size: 0.82rem;
}

.btn-primary {
  background: rgba(255, 255, 255, 0.9);
  color: #0a0a0a;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.btn-primary:hover {
  background: #fff;
  box-shadow: 0 2px 12px rgba(255, 255, 255, 0.15);
}

.btn-ghost {
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.btn-ghost:hover {
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.15);
}

/* Responsive */
@media (max-width: 900px) {
  .navbar { padding: 10px 18px; left: 16px; right: 16px; gap: 8px; }
  .nav-links { gap: 2px; }
  .nav-section-link { display: none; }
  .nav-name { font-size: 0.84rem; }
  .nav-divider { display: none; }
  .nav-username { display: none; }
}

@media (max-width: 480px) {
  .navbar { padding: 10px 12px; left: 8px; right: 8px; top: 6px; border-radius: var(--radius-lg); }
  .nav-logo { width: 26px; height: 26px; }
  .nav-name { font-size: 0.8rem; }
}
</style>

<template>
  <div :class="containerClass">
    <img
      v-if="user?.avatar_url"
      :src="user.avatar_url"
      :alt="user.login || 'Signed in user'"
      class="nav-avatar"
    />
    <div v-else class="nav-avatar-fallback">
      {{ fallbackInitial }}
    </div>
    <span :class="usernameClass">{{ user?.login }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type NavbarUser = {
  avatar_url?: string | null
  login?: string | null
}

const props = withDefaults(defineProps<{
  user: NavbarUser | null
  mobile?: boolean
}>(), {
  mobile: false,
})

const containerClass = computed(() => props.mobile ? 'nav-mobile-user' : 'nav-auth-user')
const usernameClass = computed(() => props.mobile ? 'nav-mobile-username' : 'nav-username')
const fallbackInitial = computed(() => props.user?.login?.charAt(0).toUpperCase() || '?')
</script>

<template>
  <template v-if="!auth.isSignedIn.value">
    <button :class="signInClasses" type="button" aria-label="Sign in with GitHub" @click="signIn">
      <GitHubIcon v-if="mobile" :size="16" />
      Sign in
    </button>
  </template>
  <template v-else>
    <RouterLink class="nav-btn nav-btn-ghost nav-btn-sm" to="/my-work" @click="emit('close')">My work</RouterLink>
    <RouterLink class="nav-btn nav-btn-ghost nav-btn-sm" to="/inbox" @click="emit('close')">Inbox</RouterLink>
    <RouterLink class="nav-btn nav-btn-ghost nav-btn-sm" to="/messages" @click="emit('close')">Messages</RouterLink>
    <NavbarUserBadge :user="auth.user.value" :mobile="mobile" />
    <button :class="signOutClasses" type="button" @click="signOut">
      Sign Out
    </button>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import GitHubIcon from '@/components/icons/GitHubIcon.vue'
import { useAuth } from '@/composables/useAuth'
import NavbarUserBadge from './NavbarUserBadge.vue'

const props = withDefaults(defineProps<{
  mobile?: boolean
}>(), {
  mobile: false,
})

const emit = defineEmits<{
  close: []
}>()

const auth = useAuth()

const signInClasses = computed(() => [
  'nav-btn',
  'nav-btn-sm',
  props.mobile ? 'nav-btn-ghost nav-mobile-auth-button' : 'nav-sign-in',
])

const signOutClasses = computed(() => [
  'nav-signout',
  props.mobile ? 'nav-mobile-signout' : '',
])

function signIn() {
  void auth.signIn()
  emit('close')
}

function signOut() {
  void auth.signOut()
  emit('close')
}
</script>

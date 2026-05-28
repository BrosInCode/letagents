<template>
  <template v-if="!auth.isSignedIn.value">
    <button :class="signInClasses" type="button" @click="signIn">
      <GitHubIcon :size="16" />
      Sign In
    </button>
  </template>
  <template v-else>
    <NavbarUserBadge :user="auth.user.value" :mobile="mobile" />
    <button :class="signOutClasses" type="button" @click="signOut">
      Sign Out
    </button>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
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
  'nav-btn-ghost',
  'nav-btn-sm',
  props.mobile ? 'nav-mobile-auth-button' : '',
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

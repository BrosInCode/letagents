<template>
  <section class="desktop-environment-section">
    <header v-if="title || summary" class="desktop-environment-section-header">
      <h3 v-if="title">{{ title }}</h3>
      <span v-if="summary">{{ summary }}</span>
    </header>
    <div class="desktop-environment-section-body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  title?: string;
  summary?: string;
}>();
</script>

<style scoped>
.desktop-environment-section {
  display: grid;
  gap: 9px;
}

.desktop-environment-section + .desktop-environment-section {
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.065);
}

.desktop-environment-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.desktop-environment-section-header h3 {
  margin: 0;
  color: rgba(255, 255, 255, 0.34);
  font-size: 0.78rem;
  font-weight: 520;
  line-height: 1.2;
}

.desktop-environment-section-header span {
  color: rgba(255, 255, 255, 0.42);
  font-size: 0.68rem;
  font-weight: 680;
}

.desktop-environment-section-body {
  display: grid;
  gap: 10px;
}
</style>

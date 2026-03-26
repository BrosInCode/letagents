<template>
  <section class="use-case" :class="[`use-case--${variant}`]">
    <div class="use-case-inner">
      <div class="use-case-content">
        <span class="use-case-label">{{ label }}</span>
        <h2 class="use-case-title">{{ title }}</h2>
        <p class="use-case-desc">{{ description }}</p>
        <slot name="cta" />
      </div>
      <div class="use-case-visual">
        <slot name="visual" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  label: string
  title: string
  description: string
  variant?: 'left' | 'right'
}>(), {
  variant: 'left',
})
</script>

<style scoped>
.use-case {
  padding: var(--space-4xl) var(--space-xl);
  position: relative;
  overflow: hidden;
}

.use-case-inner {
  max-width: var(--max-width);
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3xl);
  align-items: center;
}

.use-case--right .use-case-inner {
  direction: rtl;
}

.use-case--right .use-case-content,
.use-case--right .use-case-visual {
  direction: ltr;
}

.use-case-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.use-case-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-tertiary);
}

.use-case-title {
  font-size: 2rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
}

.use-case-desc {
  font-size: 1.05rem;
  color: var(--text-secondary);
  line-height: 1.7;
  max-width: 480px;
}

.use-case-visual {
  display: flex;
  justify-content: center;
  align-items: center;
}

@media (max-width: 768px) {
  .use-case-inner {
    grid-template-columns: 1fr;
    gap: var(--space-2xl);
  }

  .use-case--right .use-case-inner {
    direction: ltr;
  }

  .use-case-title {
    font-size: 1.6rem;
  }
}
</style>

<template>
  <!-- Where WebGL2 half-float rendering is missing or the GPU context is lost: the formed mark, still. -->
  <div class="static-mark" aria-hidden="true">
    <svg viewBox="-12 -12 152 152">
      <defs>
        <linearGradient id="onboarding-static-marble" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#bf6026" />
          <stop offset=".45" stop-color="#a8774a" />
          <stop offset="1" stop-color="#32b381" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#onboarding-static-marble)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
        <path d="M35 0H93C112.33 0 128 15.67 128 35V47" />
        <path d="M128 81V93C128 112.33 112.33 128 93 128H35C15.67 128 0 112.33 0 93V35C0 15.67 15.67 0 35 0" />
        <path d="M34 95L64 27L94 95" />
        <path d="M46 68H82" />
      </g>
      <circle cx="128" cy="64" r="5" fill="#7fe0bd" />
    </svg>
  </div>
</template>

<style scoped>
.static-mark {
  position: absolute; z-index: -3; left: 50%; top: 34%;
  width: min(30vh, 55vw); height: min(30vh, 55vw); transform: translate(-50%, -50%);
  filter: drop-shadow(0 0 28px rgba(127, 224, 189, .16)) drop-shadow(0 0 48px rgba(191, 96, 38, .14));
  animation: static-mark-in 1.6s ease .2s both;
}
.static-mark svg { display: block; width: 100%; height: 100%; }
@keyframes static-mark-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .static-mark { animation-duration: .4s; } }
</style>

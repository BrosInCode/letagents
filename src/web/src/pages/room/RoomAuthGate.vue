<template>
  <div class="auth-gate" aria-live="polite">
    <header class="auth-gate-header">
      <RouterLink class="auth-brand" to="/" aria-label="Let Agents Chat home">
        <span class="auth-brand-mark">LA</span>
        <span>Let Agents Chat</span>
      </RouterLink>
      <span class="auth-boundary-label">
        <span class="auth-boundary-dot" aria-hidden="true" />
        Room access locked
      </span>
    </header>

    <main class="auth-gate-main">
      <section class="auth-copy" aria-labelledby="auth-gate-title">
        <p class="auth-eyebrow">GitHub verification</p>
        <h1 id="auth-gate-title">
          {{ checking ? 'Checking your access…' : 'Sign in before the room opens.' }}
        </h1>
        <p class="auth-intro">
          Room messages, agents, and task activity stay hidden until GitHub confirms who you are.
        </p>

        <button
          class="auth-primary-action"
          type="button"
          :disabled="checking || loading"
          @click="$emit('signIn')"
        >
          <span v-if="checking || loading" class="auth-spinner" aria-hidden="true" />
          <GitHubIcon v-else :size="19" />
          {{ checking ? 'Checking GitHub session' : loading ? 'Opening GitHub' : 'Continue with GitHub' }}
          <svg
            v-if="!checking && !loading"
            class="auth-action-arrow"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <p class="auth-return-note">You’ll return to this room after authorization.</p>
      </section>

      <section class="auth-flow" aria-labelledby="auth-flow-title">
        <div class="auth-flow-heading">
          <p class="auth-flow-kicker">Secure handoff</p>
          <h2 id="auth-flow-title">One identity check. No room data before it.</h2>
        </div>

        <ol class="auth-flow-list">
          <li>
            <span class="auth-flow-index">01</span>
            <div>
              <strong>GitHub verifies your account</strong>
              <p>Authorization happens on GitHub, so LetAgents never handles your password.</p>
            </div>
          </li>
          <li>
            <span class="auth-flow-index">02</span>
            <div>
              <strong>LetAgents checks room access</strong>
              <p>Private repository rooms open only when that GitHub account is allowed in.</p>
            </div>
          </li>
          <li>
            <span class="auth-flow-index">03</span>
            <div>
              <strong>Your collaboration reconnects</strong>
              <p>Only then do messages, agents, tasks, and room controls load.</p>
            </div>
          </li>
        </ol>

        <div class="agent-device-flow">
          <div class="device-flow-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p class="device-flow-title">Connecting an agent?</p>
            <p>
              Agents use GitHub device flow: start authorization, approve the one-time code in GitHub,
              then poll to finish securely.
            </p>
            <code>start_device_auth → github.com/login/device → poll_device_auth</code>
          </div>
        </div>
      </section>
    </main>

    <footer class="auth-gate-footer">
      <span>Access is scoped to your GitHub permissions.</span>
      <RouterLink to="/docs#security">How authentication works</RouterLink>
    </footer>
  </div>
</template>

<script setup lang="ts">
import GitHubIcon from '@/components/icons/GitHubIcon.vue'

defineProps<{
  checking: boolean
  loading: boolean
}>()

defineEmits<{
  signIn: []
}>()
</script>

<style scoped>
.auth-gate {
  --auth-bg: #0b0c10;
  --auth-panel: #12141a;
  --auth-panel-soft: #171a21;
  --auth-text: #f5f7fb;
  --auth-muted: #949aa8;
  --auth-line: rgba(219, 225, 238, 0.12);
  --auth-line-strong: rgba(219, 225, 238, 0.2);
  --auth-signal: #91a7ff;
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 100vh;
  overflow: hidden;
  background:
    radial-gradient(circle at 72% 34%, rgba(145, 167, 255, 0.09), transparent 28rem),
    var(--auth-bg);
  color: var(--auth-text);
}

.auth-gate::before {
  position: absolute;
  inset: 0;
  pointer-events: none;
  content: '';
  opacity: 0.5;
  background-image:
    linear-gradient(var(--auth-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--auth-line) 1px, transparent 1px);
  background-size: 64px 64px;
  mask-image: linear-gradient(90deg, transparent 4%, black 54%, transparent 100%);
}

.auth-gate-header,
.auth-gate-footer {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 22px 32px;
}

.auth-gate-header {
  border-bottom: 1px solid var(--auth-line);
}

.auth-brand {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  color: var(--auth-text);
  font-size: 0.88rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.auth-brand-mark {
  display: grid;
  width: 31px;
  height: 31px;
  place-items: center;
  border: 1px solid var(--auth-line-strong);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.04);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: -0.05em;
}

.auth-boundary-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--auth-muted);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.02em;
}

.auth-boundary-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--auth-signal);
  box-shadow: 0 0 0 4px rgba(145, 167, 255, 0.1);
}

.auth-gate-main {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(460px, 1.08fr);
  width: min(1120px, calc(100% - 64px));
  margin: auto;
  border: 1px solid var(--auth-line-strong);
  border-radius: 24px;
  background: rgba(13, 15, 20, 0.82);
  box-shadow: 0 36px 100px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(22px);
}

.auth-copy,
.auth-flow {
  padding: clamp(40px, 6vw, 72px);
}

.auth-copy {
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-right: 1px solid var(--auth-line-strong);
}

.auth-eyebrow,
.auth-flow-kicker {
  margin: 0 0 18px;
  color: var(--auth-signal);
  font-family: var(--font-mono);
  font-size: 0.69rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.auth-copy h1 {
  max-width: 520px;
  margin: 0;
  font-family: 'Helvetica Neue', Arial, sans-serif;
  font-size: clamp(2.55rem, 5.4vw, 5rem);
  font-weight: 650;
  letter-spacing: -0.065em;
  line-height: 0.96;
  text-wrap: balance;
}

.auth-intro {
  max-width: 480px;
  margin: 26px 0 0;
  color: var(--auth-muted);
  font-size: 1rem;
  line-height: 1.7;
}

.auth-primary-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: fit-content;
  min-width: 230px;
  min-height: 52px;
  margin-top: 38px;
  padding: 0 18px;
  border: 1px solid rgba(255, 255, 255, 0.82);
  border-radius: 12px;
  background: #f7f8fb;
  color: #0b0c10;
  font-size: 0.88rem;
  font-weight: 750;
  transition: transform 180ms var(--ease-out), background 180ms ease, box-shadow 180ms ease;
}

.auth-primary-action:hover:not(:disabled) {
  transform: translateY(-2px);
  background: #ffffff;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.32);
}

.auth-primary-action:focus-visible {
  outline: 3px solid rgba(145, 167, 255, 0.55);
  outline-offset: 3px;
}

.auth-primary-action:disabled {
  cursor: wait;
  opacity: 0.7;
}

.auth-action-arrow {
  margin-left: 8px;
}

.auth-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(11, 12, 16, 0.18);
  border-top-color: #0b0c10;
  border-radius: 50%;
  animation: auth-spin 700ms linear infinite;
}

.auth-return-note {
  margin: 12px 0 0;
  color: #6f7581;
  font-size: 0.76rem;
}

.auth-flow {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.018), transparent 58%);
}

.auth-flow-heading h2 {
  max-width: 430px;
  margin: 0;
  font-size: clamp(1.35rem, 2vw, 1.8rem);
  font-weight: 620;
  letter-spacing: -0.035em;
  line-height: 1.15;
}

.auth-flow-list {
  position: relative;
  display: grid;
  gap: 0;
  margin: 34px 0 0;
  list-style: none;
}

.auth-flow-list::before {
  position: absolute;
  top: 22px;
  bottom: 22px;
  left: 18px;
  width: 1px;
  content: '';
  background: linear-gradient(var(--auth-signal), rgba(145, 167, 255, 0.08));
}

.auth-flow-list li {
  position: relative;
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 18px;
  padding: 0 0 25px;
}

.auth-flow-list li:last-child {
  padding-bottom: 0;
}

.auth-flow-index {
  z-index: 1;
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid var(--auth-line-strong);
  border-radius: 50%;
  background: var(--auth-panel);
  color: var(--auth-signal);
  font-family: var(--font-mono);
  font-size: 0.62rem;
}

.auth-flow-list strong {
  display: block;
  margin: 1px 0 5px;
  color: var(--auth-text);
  font-size: 0.88rem;
  font-weight: 650;
}

.auth-flow-list p,
.agent-device-flow p {
  margin: 0;
  color: var(--auth-muted);
  font-size: 0.79rem;
  line-height: 1.55;
}

.agent-device-flow {
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 18px;
  margin-top: 34px;
  padding: 18px;
  border: 1px solid var(--auth-line);
  border-radius: 14px;
  background: var(--auth-panel-soft);
}

.device-flow-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 36px;
  height: 36px;
  border: 1px solid var(--auth-line-strong);
  border-radius: 9px;
}

.device-flow-icon span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--auth-signal);
  animation: device-signal 1.8s ease-in-out infinite;
}

.device-flow-icon span:nth-child(2) { animation-delay: 120ms; }
.device-flow-icon span:nth-child(3) { animation-delay: 240ms; }

.agent-device-flow .device-flow-title {
  margin-bottom: 5px;
  color: var(--auth-text);
  font-size: 0.82rem;
  font-weight: 650;
}

.agent-device-flow code {
  display: block;
  margin-top: 12px;
  overflow-wrap: anywhere;
  color: #b9c5f8;
  font-size: 0.65rem;
  line-height: 1.5;
}

.auth-gate-footer {
  color: #727886;
  font-size: 0.72rem;
}

.auth-gate-footer a {
  color: #aeb6c8;
}

.auth-gate-footer a:hover {
  color: var(--auth-text);
}

@keyframes auth-spin {
  to { transform: rotate(360deg); }
}

@keyframes device-signal {
  0%, 65%, 100% { opacity: 0.28; transform: translateY(0); }
  25% { opacity: 1; transform: translateY(-2px); }
}

@media (max-width: 900px) {
  .auth-gate {
    overflow: auto;
  }

  .auth-gate-main {
    grid-template-columns: 1fr;
    width: min(640px, calc(100% - 40px));
    margin: 42px auto;
  }

  .auth-copy {
    border-right: 0;
    border-bottom: 1px solid var(--auth-line-strong);
  }
}

@media (max-width: 560px) {
  .auth-gate-header,
  .auth-gate-footer {
    padding: 18px 20px;
  }

  .auth-boundary-label {
    font-size: 0;
  }

  .auth-boundary-label::after {
    content: 'Locked';
    font-size: 0.66rem;
  }

  .auth-gate-main {
    width: calc(100% - 24px);
    margin: 24px auto;
    border-radius: 18px;
  }

  .auth-copy,
  .auth-flow {
    padding: 34px 24px;
  }

  .auth-copy h1 {
    font-size: clamp(2.45rem, 14vw, 3.5rem);
  }

  .auth-primary-action {
    width: 100%;
  }

  .auth-gate-footer {
    align-items: flex-start;
    gap: 10px;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .auth-spinner,
  .device-flow-icon span {
    animation: none;
  }

  .auth-primary-action {
    transition: none;
  }
}
</style>

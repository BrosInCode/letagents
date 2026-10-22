<template>
  <form class="connector-form" @submit.prevent="save">
    <p v-if="feedback" class="connector-feedback" role="status">
      {{ feedback }}
    </p>
    <template v-if="provider === 'github'"
      ><p>
        LetAgents reads issues through its GitHub App. Enter a repository where
        the App is installed and that you can open on GitHub. Each room chooses
        which accessible repositories to import.
      </p>
      <label class="connector-field"
        >Repository<input
          v-model.trim="repository"
          placeholder="owner/repo"
          required
          autocomplete="off" /></label
    ></template>
    <template v-else>
      <template v-if="availability?.oauth && api.connectOAuth"
        ><p>Sign in with {{ label }} in your browser, then return here.</p>
        <div class="connector-actions">
          <button
            class="connector-primary"
            type="button"
            :disabled="!!busy"
            @click="oauth"
          >
            {{
              busy === "oauth"
                ? "Waiting for your browser…"
                : `Sign in with ${label}`
            }}</button
          ><button
            v-if="busy === 'oauth'"
            class="connector-secondary"
            type="button"
            @click="api.cancelOAuth?.()"
          >
            Cancel sign-in
          </button>
        </div></template
      >
      <p v-else-if="availability?.oauth">
        Browser sign-in is available in the desktop app.
        {{
          availability?.api_token
            ? "You can use an API token here."
            : "Open the desktop app to connect this provider."
        }}
      </p>
      <details
        v-if="availability?.oauth && api.connectOAuth && availability.api_token"
        class="connector-token-toggle"
        @toggle="tokenOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary>Use an API token instead</summary>
      </details>
      <template
        v-if="
          availability?.api_token &&
          (!availability.oauth || !api.connectOAuth || tokenOpen)
        "
      >
        <template v-if="provider === 'jira'"
          ><label class="connector-field"
            >Jira site<input
              v-model.trim="site"
              type="url"
              placeholder="https://your-team.atlassian.net"
              required
              autocomplete="off" /></label
          ><label class="connector-field"
            >Atlassian email<input
              v-model.trim="email"
              type="email"
              required
              autocomplete="off" /></label
        ></template>
        <label class="connector-field"
          >{{ provider === "jira" ? "API token" : "Linear API key"
          }}<input v-model="token" type="password" required autocomplete="off"
        /></label>
        <p>
          The token is checked with {{ label }} and stored encrypted on the
          LetAgents server. It is never shown again.
        </p>
      </template>
    </template>
    <div
      v-if="
        provider === 'github' ||
        (availability?.api_token &&
          (!availability.oauth || !api.connectOAuth || tokenOpen))
      "
      class="connector-actions"
    >
      <button
        class="connector-primary"
        :disabled="!!busy || (provider === 'github' ? !repository : !token)"
      >
        {{ busy === "save" ? "Connecting…" : "Connect" }}</button
      ><button
        class="connector-secondary"
        type="button"
        :disabled="busy === 'save'"
        @click="$emit('cancel')"
      >
        Cancel
      </button>
    </div>
  </form>
</template>
<script setup lang="ts">
import { safeUserVisibleErrorDetail } from "../../../apps/desktop/renderer/src/domain/user-visible-error";
import { computed, onBeforeUnmount, ref } from "vue";
import {
  trackerProviderLabel,
  type TrackerConnectionView,
  type TrackerProvider,
  type TrackerProviderAvailability,
} from "../../ticket-connectors.mjs";
import type { TrackerApi } from "./types";
const props = defineProps<{
  provider: TrackerProvider;
  api: TrackerApi;
  availability?: TrackerProviderAvailability;
}>();
const emit = defineEmits<{
  connected: [connection: TrackerConnectionView];
  cancel: [];
}>();
const label = computed(() => trackerProviderLabel(props.provider));
const tokenOpen = ref(false);
const site = ref(""),
  email = ref(""),
  token = ref(""),
  repository = ref(""),
  busy = ref(""),
  feedback = ref("");
let live = true;
onBeforeUnmount(() => {
  live = false;
  token.value = "";
  if (busy.value === "oauth") void props.api.cancelOAuth?.();
});
async function run(action: string, task: () => Promise<TrackerConnectionView>) {
  if (busy.value) return;
  busy.value = action;
  feedback.value = "";
  try {
    const result = await task();
    if (live) {
      token.value = "";
      emit("connected", result);
    }
  } catch (error) {
    if (live)
      feedback.value = safeUserVisibleErrorDetail(
        error,
        "Could not connect. Try again.",
      );
  } finally {
    if (live) busy.value = "";
  }
}
function save() {
  if (props.provider !== "github" && !props.availability?.api_token) return;
  return run("save", () =>
    props.provider === "github"
      ? props.api.connectGitHub(repository.value)
      : props.api.saveApiToken(
          props.provider === "jira"
            ? {
                provider: "jira",
                site_url: site.value,
                email: email.value,
                api_token: token.value,
              }
            : { provider: "linear", api_token: token.value },
        ),
  );
}
function oauth() {
  if (props.api.connectOAuth)
    return run("oauth", () => props.api.connectOAuth!(props.provider));
}
</script>

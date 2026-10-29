<template>
  <div class="desktop-modal-backdrop" data-testid="new-room-modal" @click.self="requestClose">
    <section ref="dialogElement" class="desktop-new-room-modal desktop-new-room-flow" role="dialog" aria-modal="true"
      aria-labelledby="new-room-title" aria-describedby="new-room-title-description"
      :aria-busy="busy" tabindex="-1" @keydown.esc.prevent="requestClose" @keydown.tab="handleDialogTab">
      <NewRoomFrame :tab="activeTab" :tabs="tabs" :busy="busy" :show-tabs="showTabs"
        :title="step === 'success' ? 'Room ready' : 'New room'"
        :description="step === 'success' ? 'Your next conversation starts here.' : 'Choose how you’d like to start.'"
        @select-tab="selectTab">
        <template #header-actions>
          <button class="new-room-icon-button" type="button" aria-label="Close new room dialog" :disabled="!canDismiss" @click="requestClose"><X aria-hidden="true" /></button>
        </template>

        <div v-if="activeTab === 'project' && showTabs" class="desktop-new-room-modes" aria-label="Project source">
          <button type="button" :aria-pressed="visibleStep === 'new_project'" :disabled="busy" data-testid="new-room-new-project" @click="emit('chooseNewProject')">New project</button>
          <button type="button" :aria-pressed="visibleStep === 'project'" :disabled="busy" data-testid="new-room-existing-project" @click="emit('chooseProject')">Open existing</button>
        </div>

        <form v-if="visibleStep === 'new_project'" id="new-room-create-form" data-testid="new-room-create-project-step" @submit.prevent="emit('createProject')">
          <label class="new-room-field">
            <span>Project name</span>
            <input v-model="projectName" type="text" maxlength="80" placeholder="e.g. pocket-notes" autocomplete="off"
              :disabled="busy" :aria-invalid="Boolean(projectCreationError)" :aria-describedby="projectCreationError ? 'new-room-create-error' : undefined" data-testid="new-room-project-name" />
          </label>
          <div class="new-room-field-heading"><span>Location</span><button class="desktop-new-room-text-button" type="button" :disabled="busy" :aria-expanded="showParentPath" @click="showParentPath = !showParentPath">Enter path</button></div>
          <div class="new-room-folder">
            <FolderOpen aria-hidden="true" />
            <div><strong>{{ parentLabel }}</strong><small :title="projectParent">{{ projectParent || 'Choose where your project belongs.' }}</small></div>
            <button class="new-room-button" type="button" :disabled="busy" data-testid="new-room-pick-project-parent" @click="emit('pickProjectParent')">{{ activeAction === 'pick_project_parent' ? 'Choosing…' : projectParent ? 'Change' : 'Browse' }}</button>
          </div>
          <label v-if="showParentPath" class="new-room-field desktop-new-room-path-field">
            <span>Location path</span><input v-model="projectParent" type="text" :placeholder="pathExamples.parent" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="busy" data-testid="new-room-project-parent" />
          </label>
          <p v-if="projectParent.trim()" class="new-room-hint desktop-new-room-destination" data-testid="new-room-project-destination">New folder <span>{{ joinLocalPath(projectParent, projectName.trim() || 'your-project') }}</span></p>
          <p class="new-room-hint desktop-new-room-context">Creates an empty folder and a local room for it. You can connect Git and share the room later.</p>
          <p v-if="projectCreationError" id="new-room-create-error" class="new-room-error" role="alert">{{ projectCreationError }}</p>
        </form>

        <div v-else-if="visibleStep === 'project'" data-testid="new-room-project-step">
          <div class="new-room-field-heading"><span>Project folder</span><button type="button" class="desktop-new-room-text-button" :disabled="busy" :aria-expanded="showProjectPath" @click="showProjectPath = !showProjectPath">Enter path</button></div>
          <div class="new-room-folder">
            <FolderOpen aria-hidden="true" />
            <div><strong>{{ projectSelection?.folderLabel || 'Choose a folder' }}</strong><small :title="projectSelection?.repoPath || ''">{{ projectSelection?.repoPath || `Open the room for a project on ${thisComputer}.` }}</small></div>
            <button class="new-room-button" type="button" :disabled="busy" data-testid="new-room-open-project" @click="emit('openProject')">{{ activeAction === 'pick_project' ? 'Choosing…' : projectSelection ? 'Change' : 'Browse' }}</button>
          </div>
          <form v-if="showProjectPath || projectPathError" class="new-room-field desktop-new-room-path-field" data-testid="new-room-project-path-form" @submit.prevent="emit('openProjectPath')">
            <label for="new-room-project-path-input">Folder path</label>
            <div class="desktop-new-room-path-row">
              <input id="new-room-project-path-input" ref="projectPathInputElement" v-model="projectPath" type="text" :placeholder="pathExamples.project" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="busy" :aria-invalid="Boolean(projectPathError)" :aria-describedby="projectPathError ? 'new-room-project-path-error' : undefined" data-testid="new-room-project-path-input" />
              <button class="new-room-button" type="submit" :disabled="busy || !projectPath.trim()" data-testid="new-room-project-path-submit">{{ activeAction === 'open_project_path' ? 'Opening…' : 'Use path' }}</button>
            </div>
            <small v-if="projectPathError" id="new-room-project-path-error" class="new-room-error" role="alert">{{ projectPathError }}</small>
          </form>
          <section v-if="recentProjectFolders.length && !projectSelection" class="desktop-new-room-recent" aria-labelledby="new-room-recent-title" data-testid="new-room-recent-folders">
            <h3 id="new-room-recent-title">Recent folders</h3>
            <button v-for="folder in recentProjectFolders" :key="folder.path" type="button" :disabled="busy" :title="folder.path" data-testid="new-room-recent-folder" @click="emit('openProjectPath', folder.path)">
              <FolderOpen aria-hidden="true" /><span><strong>{{ folder.label }}</strong><small>{{ folder.path }}</small></span><ChevronRight aria-hidden="true" />
            </button>
          </section>
          <div v-if="projectSelection" data-testid="new-room-project-preview">
            <dl class="new-room-details">
              <div><dt>Room</dt><dd>{{ projectSelection.roomName }}</dd></div>
              <div v-if="projectSelection.repoStatus?.branch"><dt>Branch</dt><dd>{{ projectSelection.repoStatus.branch }}</dd></div>
              <div><dt>Connection</dt><dd>{{ projectSelection.sourceLabel }}</dd></div>
            </dl>
            <p v-if="projectSelection.warning" class="new-room-hint">{{ projectSelection.warning }}</p>
          </div>
          <p class="new-room-hint desktop-new-room-context">{{ projectSelection ? 'Open this project’s room and pick up where you left off.' : 'A Git folder opens its existing project room. Other folders start locally.' }}</p>
        </div>

        <form v-else-if="step === 'standalone'" id="new-room-blank-form" data-testid="new-room-standalone-step" @submit.prevent="emit('createStandalone')">
          <label class="new-room-field"><span>Room name</span><input v-model="roomName" type="text" maxlength="80" placeholder="e.g. Design conversations" autocomplete="off" spellcheck="false" :disabled="busy" data-testid="new-room-name-input" /></label>
          <fieldset class="new-room-storage" :disabled="busy">
            <legend>Where it lives</legend>
            <label data-testid="new-room-storage-cloud"><input v-model="storage" type="radio" value="cloud" /><Cloud aria-hidden="true" /><span><strong>Shared online</strong><small>Invite your people and agents with a code.</small></span></label>
            <label data-testid="new-room-storage-local"><input v-model="storage" type="radio" value="local" /><Laptop aria-hidden="true" /><span><strong>Only on {{ thisComputer }}</strong><small>Stays on this device until you choose to share it.</small></span></label>
          </fieldset>
          <p class="new-room-hint desktop-new-room-context">{{ storage === 'cloud' ? 'You’ll get an invite code to share.' : `Your room will stay on ${thisComputer}.` }}</p>
        </form>

        <form v-else-if="step === 'join'" id="new-room-join-form" data-testid="new-room-join-step" @submit.prevent="emit('join')">
          <label class="new-room-field"><span>Invite code or room link</span><input ref="joinInputElement" v-model="joinCode" type="text" placeholder="ABCD-1234" autocomplete="off" autocapitalize="characters" spellcheck="false" :disabled="busy" :aria-invalid="Boolean(joinError)" :aria-describedby="joinError ? 'new-room-join-error' : 'new-room-join-hint'" data-testid="new-room-join-input" />
            <small v-if="joinError" id="new-room-join-error" class="new-room-error" role="alert">{{ joinError }}</small>
            <small id="new-room-join-hint" class="new-room-hint">Paste an invite code or a LetAgents room link.</small>
          </label>
          <div class="desktop-new-room-join-note"><KeyRound aria-hidden="true" /><div><strong>A place for your team.</strong><p class="new-room-hint">Ask someone in the room for an invitation. You’ll join using your signed-in profile.</p></div></div>
        </form>

        <div v-else-if="step === 'working'" class="desktop-new-room-working" data-testid="new-room-working-step" role="status" aria-live="polite"><span class="desktop-new-room-spinner" aria-hidden="true" /><p>{{ statusMessage || 'Working…' }}</p></div>
        <div v-else-if="step === 'success' && success" data-testid="new-room-success-step">
          <div class="desktop-new-room-success-mark"><Check aria-hidden="true" /></div>
          <h3 class="desktop-new-room-success-title">Your room is ready.</h3>
          <div class="new-room-folder"><Hash aria-hidden="true" /><div><strong>{{ success.roomName }}</strong><small>{{ success.storageLabel }}</small></div></div>
          <div v-if="success.inviteCode" class="desktop-new-room-invite" data-testid="new-room-invite-code"><label>Invite code</label><div><code>{{ success.inviteCode }}</code><button type="button" class="new-room-icon-button" aria-label="Copy invite code" data-testid="new-room-copy-code" @click="emit('copyCode')"><Copy aria-hidden="true" /></button></div><p class="new-room-hint">Share this with anyone you’d like to join.</p></div>
        </div>
        <div v-else-if="step === 'error'" data-testid="new-room-error-step"><p ref="errorElement" class="new-room-error" role="alert" tabindex="-1">{{ feedback || 'Something went wrong.' }}</p><p class="new-room-hint">Your inputs are still here. Go back to make a change or try again.</p></div>
        <p v-if="feedback && step !== 'error'" :class="feedbackState === 'error' ? 'new-room-error' : 'new-room-hint'" :role="feedbackState === 'error' ? 'alert' : 'status'">{{ feedback }}</p>

        <template #footer>
          <template v-if="step === 'success'">
            <button class="new-room-cancel" type="button" data-testid="new-room-done" @click="emit('dismissSuccess')">Done</button>
            <button class="new-room-primary" type="button" data-testid="new-room-open-success" @click="emit('openSuccess')">Open room <ChevronRight aria-hidden="true" /></button>
          </template>
          <template v-else-if="step === 'error'">
            <button class="new-room-cancel" type="button" data-testid="new-room-error-back" @click="emit('back')">Back</button>
            <button class="new-room-primary" type="button" data-testid="new-room-retry" :disabled="busy" @click="emit('retry')">Try again</button>
          </template>
          <template v-else>
            <button class="new-room-cancel" type="button" :disabled="!canDismiss" data-testid="new-room-cancel" @click="requestClose">Cancel</button>
            <button v-if="visibleStep === 'new_project'" class="new-room-primary" type="submit" form="new-room-create-form" :disabled="busy || !projectName.trim() || !projectParent.trim()" data-testid="new-room-create-project">{{ activeAction === 'create_project' ? 'Creating…' : 'Create project' }} <ChevronRight aria-hidden="true" /></button>
            <button v-else-if="visibleStep === 'project'" ref="confirmProjectElement" class="new-room-primary" type="button" :disabled="busy || !projectSelection" data-testid="new-room-confirm-project" @click="emit('confirmProject')">Open project room <ChevronRight aria-hidden="true" /></button>
            <button v-else-if="step === 'standalone'" class="new-room-primary" type="submit" form="new-room-blank-form" :disabled="busy || !canSubmitStandalone" data-testid="new-room-create-standalone">Create room <ChevronRight aria-hidden="true" /></button>
            <button v-else-if="step === 'join'" class="new-room-primary" type="submit" form="new-room-join-form" :disabled="busy || !canSubmitJoin" data-testid="new-room-join-submit">Join room <ChevronRight aria-hidden="true" /></button>
          </template>
        </template>
      </NewRoomFrame>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FolderOpen, Hash, KeyRound, X, ChevronRight, Cloud, Laptop, Check, Copy } from '@lucide/vue';
import NewRoomFrame from '../../../../../../../shared/ui/NewRoomFrame.vue';
import type { NewRoomActiveAction, NewRoomRecentProjectFolder, NewRoomStep, NewRoomStorageChoice, NewRoomSuccessState, PendingProjectRoomSelection } from '../../../composables/useDesktopNewRoomModal';
import { currentFocusableElement, restoreFocus, trapFocusInDialog } from './modal-focus';
import { joinLocalPath, localPathBasename, localPathExamples } from '../../../domain/local-path';
import { thisComputerLabel } from '../../../domain/supervised-agents-support';

const props = defineProps<{
  step: NewRoomStep; busy: boolean; canDismiss: boolean; activeAction: NewRoomActiveAction;
  feedback: string | null; feedbackState: 'info' | 'error' | 'success';
  projectSelection: PendingProjectRoomSelection | null; projectPathError: string | null;
  projectCreationError: string | null; recentProjectFolders: readonly NewRoomRecentProjectFolder[];
  success: NewRoomSuccessState | null; statusMessage: string | null; joinError: string | null;
  canSubmitJoin: boolean; canSubmitStandalone: boolean;
}>();
const joinCode = defineModel<string>('joinCode', { required: true });
const roomName = defineModel<string>('roomName', { required: true });
const storage = defineModel<NewRoomStorageChoice>('storage', { required: true });
const projectPath = defineModel<string>('projectPath', { default: '' });
const projectName = defineModel<string>('projectName', { default: '' });
const projectParent = defineModel<string>('projectParent', { default: '' });
const emit = defineEmits<{
  back: []; chooseJoin: []; chooseProject: []; chooseNewProject: []; chooseStandalone: [];
  close: []; confirmProject: []; copyCode: []; createStandalone: []; createProject: [];
  dismissSuccess: []; join: []; openProject: []; openProjectPath: [path?: string];
  pickProjectParent: []; openSuccess: []; retry: [];
}>();
const tabs = [{ id: 'project', label: 'Project' }, { id: 'standalone', label: 'Blank room' }, { id: 'join', label: 'Join room' }];
const visibleStep = computed(() => props.step === 'chooser' ? 'new_project' : props.step);
const activeTab = computed(() => ['project', 'new_project'].includes(visibleStep.value) ? 'project' : props.step);
const showTabs = computed(() => !['working', 'success', 'error'].includes(props.step));
const showProjectPath = ref(false);
const showParentPath = ref(false);
const projectMode = ref<'project' | 'new_project'>(props.step === 'project' ? 'project' : 'new_project');
const parentLabel = computed(() => localPathBasename(projectParent.value) || 'Choose a location');
const pathExamples = localPathExamples();
const thisComputer = thisComputerLabel();
const dialogElement = ref<HTMLElement | null>(null);
const joinInputElement = ref<HTMLInputElement | null>(null);
const projectPathInputElement = ref<HTMLInputElement | null>(null);
const confirmProjectElement = ref<HTMLButtonElement | null>(null);
const errorElement = ref<HTMLElement | null>(null);
const previousFocusElement = ref<HTMLElement | null>(null);
function selectTab(tab: string) {
  if (props.busy || tab === activeTab.value) return;
  if (tab === 'project') {
    if (projectMode.value === 'project') emit('chooseProject');
    else emit('chooseNewProject');
  }
  else if (tab === 'standalone') emit('chooseStandalone');
  else if (tab === 'join') emit('chooseJoin');
}
function requestClose() { if (props.canDismiss) emit('close'); }
function handleDialogTab(event: KeyboardEvent) { trapFocusInDialog(event, dialogElement.value); }
function focusInitialControl() {
  const dialog = dialogElement.value;
  if (!dialog) return;
  const preferred = dialog.querySelector<HTMLElement>('[role="tabpanel"] input:not(:disabled), [data-testid="new-room-open-success"], [data-testid="new-room-retry"], [role="tabpanel"] button:not(:disabled)');
  (preferred || dialog).focus({ preventScroll: true });
}
onMounted(async () => { previousFocusElement.value = currentFocusableElement(); await nextTick(); focusInitialControl(); });
onBeforeUnmount(() => restoreFocus(previousFocusElement.value));
watch(() => props.step, async () => {
  if (props.step === 'project' || props.step === 'new_project') projectMode.value = props.step;
  const keepTabFocus = Boolean(dialogElement.value?.contains(document.activeElement) && document.activeElement?.closest('[role="tablist"], .desktop-new-room-modes'));
  await nextTick();
  if (props.step === 'working') {
    dialogElement.value?.focus({ preventScroll: true });
    return;
  }
  if (keepTabFocus) return;
  if (props.step === 'error') errorElement.value?.focus({ preventScroll: true });
  else focusInitialControl();
});
watch(() => props.busy, async (busy) => {
  if (!busy) return;
  const hadDialogFocus = Boolean(dialogElement.value?.contains(document.activeElement));
  await nextTick();
  if (hadDialogFocus && (!dialogElement.value?.contains(document.activeElement) || document.activeElement?.matches(':disabled'))) {
    dialogElement.value?.focus({ preventScroll: true });
  }
});
watch(() => [props.projectPathError, props.projectSelection] as const, async ([error, selection], [oldError, oldSelection]) => {
  if (props.step !== 'project') return;
  await nextTick();
  if (error && error !== oldError) projectPathInputElement.value?.focus({ preventScroll: true });
  else if (selection && selection !== oldSelection) confirmProjectElement.value?.focus({ preventScroll: true });
});
</script>

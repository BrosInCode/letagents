<template>
  <div class="desktop-modal-backdrop" data-testid="new-room-modal" @click.self="requestClose">
    <section ref="dialogElement" class="desktop-new-room-modal desktop-new-room-flow" :data-step="visibleStep" role="dialog" aria-modal="true"
      aria-labelledby="new-room-title" :aria-busy="busy" :data-input="inputMode" tabindex="-1"
      @pointerdown.capture="inputMode = 'pointer'" @keydown.capture="inputMode = 'keyboard'"
      @keydown.esc.prevent="handleEscape" @keydown.tab="handleDialogTab">
      <NewRoomFrame tab="" :tabs="[]" :show-tabs="false" :title="title" description="">
        <template #header-actions>
          <button class="new-room-icon-button" type="button" aria-label="Close new room dialog" :disabled="!canDismiss" @click="requestClose"><X aria-hidden="true" /></button>
        </template>

        <div v-if="projectPicker" class="desktop-new-room-modes" aria-label="Project source">
          <button type="button" :aria-pressed="visibleStep === 'project'" :disabled="busy" data-testid="new-room-existing-project" @click="emit('chooseProject')">Open existing</button>
          <button type="button" :aria-pressed="visibleStep === 'new_project'" :disabled="busy" data-testid="new-room-new-project" @click="emit('chooseNewProject')">New project</button>
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
            <div><strong>{{ parentLabel }}</strong><small :title="projectParent">{{ projectParent }}</small></div>
            <button class="new-room-button" type="button" :disabled="busy" data-testid="new-room-pick-project-parent" @click="emit('pickProjectParent')">{{ activeAction === 'pick_project_parent' ? 'Choosing…' : projectParent ? 'Change' : 'Browse' }}</button>
          </div>
          <label v-if="showParentPath" class="new-room-field desktop-new-room-path-field">
            <span>Location path</span><input v-model="projectParent" type="text" :placeholder="pathExamples.parent" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="busy" data-testid="new-room-project-parent" />
          </label>
          <p v-if="projectParent.trim()" class="new-room-hint desktop-new-room-destination" data-testid="new-room-project-destination">New folder <span>{{ joinLocalPath(projectParent, projectName.trim() || 'your-project') }}</span></p>
          <p v-if="projectCreationError" id="new-room-create-error" class="new-room-error" role="alert">{{ projectCreationError }}</p>
        </form>

        <div v-else-if="visibleStep === 'project'" data-testid="new-room-project-step">
          <div class="new-room-field-heading"><span>Project folder</span><button type="button" class="desktop-new-room-text-button" :disabled="busy" :aria-expanded="showProjectPath" @click="showProjectPath = !showProjectPath">Enter path</button></div>
          <div class="new-room-folder">
            <FolderOpen aria-hidden="true" />
            <div><strong>{{ projectSelection?.folderLabel || 'On this device' }}</strong><small :title="projectSelection?.repoPath || ''">{{ projectSelection?.repoPath }}</small></div>
            <button class="new-room-button" type="button" :disabled="busy" data-testid="new-room-open-project" @click="emit('openProject')">{{ activeAction === 'pick_project' ? 'Choosing…' : 'Browse' }}</button>
          </div>
          <form v-if="showProjectPath || projectPathError" class="new-room-field desktop-new-room-path-field" data-testid="new-room-project-path-form" @submit.prevent="emit('openProjectPath')">
            <label for="new-room-project-path-input">Folder path</label>
            <div class="desktop-new-room-path-row">
              <input id="new-room-project-path-input" ref="projectPathInputElement" v-model="projectPath" type="text" :placeholder="pathExamples.project" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="busy" :aria-invalid="Boolean(projectPathError)" :aria-describedby="projectPathError ? 'new-room-project-path-error' : undefined" data-testid="new-room-project-path-input" />
              <button class="new-room-button" type="submit" :disabled="busy || !projectPath.trim()" data-testid="new-room-project-path-submit">{{ activeAction === 'open_project_path' ? 'Opening…' : 'Use path' }}</button>
            </div>
            <small v-if="projectPathError" id="new-room-project-path-error" class="new-room-error" role="alert">{{ projectPathError }}</small>
          </form>
          <section v-if="recentProjectFolders.length" class="desktop-new-room-recent" aria-labelledby="new-room-recent-title" data-testid="new-room-recent-folders">
            <h3 id="new-room-recent-title">Recent folders</h3>
            <button v-for="folder in recentProjectFolders" :key="folder.path" type="button" :disabled="busy" :title="folder.path" data-testid="new-room-recent-folder" @click="emit('openProjectPath', folder.path)">
              <FolderOpen aria-hidden="true" /><span><strong>{{ folder.label }}</strong><small>{{ folder.path }}</small></span><ChevronRight aria-hidden="true" />
            </button>
          </section>
        </div>

        <form v-else-if="visibleStep === 'standalone'" id="new-room-blank-form" class="desktop-room-draft" data-testid="new-room-standalone-step"
          @submit.prevent="submitDraft">
          <div class="desktop-room-draft-scope">
            <template v-if="projectSelection">
              <CompanyAvatar v-if="projectOwner" :login="projectOwner" :avatar-url="projectCompany?.avatarUrl ?? null" size="s" />
              <Laptop v-else aria-hidden="true" />
              {{ projectOwner || projectLocation }}
            </template>
            <FilterDropdown v-else-if="organizationOptions.length > 1" class="desktop-room-picker" data-testid="new-room-organization"
              :model-value="organizationId" label="Organization" :options="organizationOptions" :disabled="busy" @update:model-value="selectOrganization">
              <template #trigger="{ option }">
                <CompanyAvatar v-if="option" :login="option.label" :avatar-url="companyFor(option.id)?.avatarUrl ?? null" size="s" />
                <span>{{ option?.label }}</span>
              </template>
              <template #option="{ option }">
                <CompanyAvatar :login="option.label" :avatar-url="companyFor(option.id)?.avatarUrl ?? null" size="s" />
                <span class="work-option-label">{{ option.label }}</span>
              </template>
            </FilterDropdown>
            <template v-else><UserRound aria-hidden="true" /> Personal</template>
            <span aria-hidden="true">/</span>
            {{ projectSelection ? 'Project room' : 'Room' }}
          </div>

          <div v-if="projectSelection" :key="projectSelection.repoPath ?? projectSelection.roomIdentifier" class="desktop-room-project" :data-reveal="revealProject" data-testid="new-room-project-preview">
            <div class="desktop-room-draft-identity">
              <span class="desktop-room-draft-mark"><Folder aria-hidden="true" /></span>
              <div class="desktop-room-draft-title">
                <span>{{ projectSelection.roomName }}</span>
                <small v-if="projectRepository">{{ projectRepository }}</small>
              </div>
            </div>
            <div class="desktop-room-project-connection">
              <div class="desktop-room-project-row">
                <button type="button" class="desktop-room-project-pick" :disabled="busy" :title="projectSelection.repoPath ?? ''" aria-label="Change project" @click="emit('chooseProject')">
                  <FolderOpen aria-hidden="true" /><span>{{ projectSelection.repoPath || projectSelection.folderLabel }}</span>
                </button>
                <button type="button" class="new-room-icon-button" aria-label="Remove project" :disabled="busy" @click="emit('removeProject')"><X aria-hidden="true" /></button>
              </div>
              <div v-if="projectSelection.repoStatus?.branch" class="desktop-room-project-branch">
                <GitBranch aria-hidden="true" />{{ projectSelection.repoStatus.branch }}
              </div>
            </div>
          </div>

          <div v-else>
            <label class="desktop-room-draft-identity">
              <span class="desktop-room-draft-mark"><MessageSquare aria-hidden="true" /></span>
              <span class="desktop-room-sr-only">Room name</span>
              <input ref="nameElement" v-model="roomName" class="desktop-room-draft-name" type="text" maxlength="80" placeholder="Room name" autocomplete="off" spellcheck="false"
                :disabled="busy" data-testid="new-room-name-input" />
            </label>
            <div class="desktop-room-project-connection">
              <button type="button" class="desktop-room-project-pick" :disabled="busy" data-testid="new-room-add-project" @click="emit('chooseProject')">
                <Folder aria-hidden="true" /><span>Add project</span><Plus aria-hidden="true" />
              </button>
            </div>
          </div>

          <div class="desktop-room-draft-access" data-testid="new-room-storage">
            <template v-if="projectSelection">
              <component :is="projectAccessIcon" aria-hidden="true" />{{ projectAccess }}
            </template>
            <template v-else-if="organizationId !== 'personal'">
              <Lock aria-hidden="true" />Invite only
            </template>
            <FilterDropdown v-else class="desktop-room-picker desktop-room-access-picker" :model-value="storage" label="Room access"
              :options="accessOptions" :disabled="busy" @update:model-value="selectPersonalStorage">
              <template #trigger="{ option }">
                <component :is="option?.id === 'local' ? Laptop : Lock" aria-hidden="true" /><span>{{ option?.label }}</span>
              </template>
              <template #option="{ option }">
                <component :is="option.id === 'local' ? Laptop : Lock" aria-hidden="true" /><span class="work-option-label">{{ option.label }}</span>
              </template>
            </FilterDropdown>
          </div>
          <p v-if="!projectSelection && companyUnavailable" class="new-room-error" role="status">
            {{ company?.login }} is unavailable. Choose another organization.
          </p>
        </form>

        <form v-else-if="visibleStep === 'join'" id="new-room-join-form" data-testid="new-room-join-step" @submit.prevent="emit('join')">
          <label class="new-room-field">
            <span>Invite code or room link</span>
            <input v-model="joinCode" type="text" placeholder="ABCD-1234" autocomplete="off" autocapitalize="characters" spellcheck="false"
              :disabled="busy" :aria-invalid="Boolean(joinError)" :aria-describedby="joinError ? 'new-room-join-error' : undefined" data-testid="new-room-join-input" />
            <small v-if="joinError" id="new-room-join-error" class="new-room-error" role="alert">{{ joinError }}</small>
          </label>
        </form>

        <p v-else-if="step === 'error'" ref="errorElement" class="new-room-error" role="alert" tabindex="-1">{{ feedback || 'Something went wrong.' }}</p>
        <p v-if="feedback && step !== 'error' && !joinError" :class="feedbackState === 'error' ? 'new-room-error' : 'new-room-hint'"
          :role="feedbackState === 'error' ? 'alert' : 'status'">{{ feedback }}</p>
        <span v-if="busy" class="desktop-room-sr-only" role="status">{{ busyLabel }}</span>

        <template #footer>
          <button v-if="step === 'error'" class="new-room-cancel" type="button" data-testid="new-room-error-back" @click="emit('back')">Back</button>
          <button v-else-if="visibleStep === 'standalone'" class="new-room-cancel desktop-room-draft-secondary" type="button"
            :disabled="busy" data-testid="new-room-join-entry" @click="emit('chooseJoin')"><KeyRound aria-hidden="true" />Join a room</button>
          <button v-else class="new-room-cancel desktop-room-draft-secondary" type="button" :disabled="busy"
            data-testid="new-room-back" @click="emit('back')"><ArrowLeft aria-hidden="true" />Back</button>

          <button v-if="step === 'error'" class="new-room-primary" type="button" data-testid="new-room-retry" @click="emit('retry')">Try again</button>
          <button v-else-if="visibleStep === 'new_project'" class="new-room-primary" type="submit" form="new-room-create-form"
            :disabled="busy || !projectName.trim() || !projectParent.trim()" data-testid="new-room-create-project">{{ busy ? busyLabel : 'Create project' }}</button>
          <button v-else-if="visibleStep === 'standalone'" ref="confirmProjectElement" class="new-room-primary" type="submit" form="new-room-blank-form"
            :disabled="!canSubmitDraft" :data-testid="projectSelection ? 'new-room-confirm-project' : 'new-room-create-standalone'">{{ busy ? busyLabel : projectSelection ? 'Open room' : 'Create room' }}</button>
          <button v-else-if="visibleStep === 'join'" class="new-room-primary" type="submit" form="new-room-join-form"
            :disabled="busy || !canSubmitJoin" data-testid="new-room-join-submit">{{ busy ? busyLabel : 'Join room' }}</button>
        </template>
      </NewRoomFrame>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowLeft, ChevronRight, Cloud, Folder, FolderOpen, GitBranch, KeyRound, Laptop, Lock, MessageSquare, Plus, UserRound, X } from '@lucide/vue';
import NewRoomFrame from '../../../../../../../shared/ui/NewRoomFrame.vue';
import FilterDropdown from '../../../../../../../shared/ui/FilterDropdown.vue';
import type { NewRoomActiveAction, NewRoomCompany, NewRoomRecentProjectFolder, NewRoomStep, NewRoomStorageChoice, PendingProjectRoomSelection } from '../../../composables/useDesktopNewRoomModal';
import CompanyAvatar from '../company/CompanyAvatar.vue';
import { currentFocusableElement, restoreFocus, trapFocusInDialog } from './modal-focus';
import { joinLocalPath, localPathBasename, localPathExamples } from '../../../domain/local-path';

const props = defineProps<{
  step: NewRoomStep; busy: boolean; canDismiss: boolean; activeAction: NewRoomActiveAction;
  feedback: string | null; feedbackState: 'info' | 'error' | 'success';
  projectSelection: PendingProjectRoomSelection | null; projectPathError: string | null;
  projectCreationError: string | null; recentProjectFolders: readonly NewRoomRecentProjectFolder[];
  companies: readonly NewRoomCompany[];
  statusMessage: string | null; joinError: string | null;
  canSubmitJoin: boolean; canSubmitStandalone: boolean;
}>();
const joinCode = defineModel<string>('joinCode', { required: true });
const roomName = defineModel<string>('roomName', { required: true });
const storage = defineModel<NewRoomStorageChoice>('storage', { required: true });
const company = defineModel<NewRoomCompany | null>('company', { required: true });
const projectPath = defineModel<string>('projectPath', { default: '' });
const projectName = defineModel<string>('projectName', { default: '' });
const projectParent = defineModel<string>('projectParent', { default: '' });
const emit = defineEmits<{
  back: []; chooseJoin: []; chooseProject: []; chooseNewProject: []; removeProject: [];
  close: []; confirmProject: []; createStandalone: []; createProject: [];
  join: []; openProject: []; openProjectPath: [path?: string]; pickProjectParent: []; retry: [];
}>();

const inputMode = ref<'pointer' | 'keyboard'>('keyboard');
const revealProject = ref(false);
const visibleStep = computed(() => props.step === 'working'
  ? props.activeAction === 'join' ? 'join' : 'standalone'
  : props.step);
const projectPicker = computed(() => visibleStep.value === 'project' || visibleStep.value === 'new_project');
const title = computed(() => projectPicker.value ? 'Choose project' : visibleStep.value === 'join' ? 'Join room' : 'New room');
const busyLabel = computed(() => props.statusMessage || 'Creating…');
const showProjectPath = ref(false);
const showParentPath = ref(false);
const parentLabel = computed(() => localPathBasename(projectParent.value.trim()) || 'Choose a location');
const pathExamples = localPathExamples();

const organizationId = computed(() => storage.value === 'company' ? company.value?.id ?? 'personal' : 'personal');
const companyFor = (id: string) => props.companies.find(item => item.id === id);
const companyUnavailable = computed(() =>
  storage.value === 'company' && (!company.value || !companyFor(company.value.id)));
const organizationOptions = computed(() => [
  { id: 'personal', label: 'Personal' },
  ...props.companies.map(item => ({ id: item.id, label: item.login })),
  ...(companyUnavailable.value && company.value
    ? [{ id: company.value.id, label: company.value.login, disabled: true }]
    : []),
]);
const accessOptions = [{ id: 'cloud', label: 'Invite only' }, { id: 'local', label: 'Only on this device' }];
const personalStorage = ref<'cloud' | 'local'>(storage.value === 'local' ? 'local' : 'cloud');
const canSubmitDraft = computed(() =>
  !props.busy && (Boolean(props.projectSelection) || (props.canSubmitStandalone && !companyUnavailable.value)));

function submitDraft() {
  if (!canSubmitDraft.value) return;
  if (props.projectSelection) emit('confirmProject');
  else emit('createStandalone');
}
function selectOrganization(id: string) {
  if (props.busy) return;
  const selected = companyFor(id);
  if (selected) {
    company.value = selected;
    storage.value = 'company';
  } else if (id === 'personal') {
    company.value = null;
    storage.value = personalStorage.value;
  }
}
function selectPersonalStorage(value: string) {
  if (props.busy || (value !== 'local' && value !== 'cloud')) return;
  personalStorage.value = value;
  storage.value = value;
}

const gitRoom = computed(() => props.projectSelection?.snapshot.room?.gitRoom);
const localProject = computed(() => ['local_folder', 'local_git'].includes(props.projectSelection?.source ?? '') || gitRoom.value?.accessMode === 'local');
const projectRepository = computed(() => {
  if (localProject.value) return '';
  return gitRoom.value?.repository.fullName || props.projectSelection?.roomIdentifier.match(/^github\.com\/([^/]+\/[^/]+)/i)?.[1] || '';
});
const projectOwner = computed(() => projectRepository.value.split('/')[0]);
const projectCompany = computed(() => props.companies.find(item => item.login.toLowerCase() === projectOwner.value.toLowerCase()));
const projectLocation = computed(() => localProject.value ? 'On this device' : 'Project');
const projectAccess = computed(() => {
  if (localProject.value) return 'Only on this device';
  if (gitRoom.value?.accessMode === 'public') return 'Public repository';
  if (gitRoom.value?.accessMode === 'private') return 'Private repository';
  return props.projectSelection?.sourceLabel ?? '';
});
const projectAccessIcon = computed(() => localProject.value ? Laptop : gitRoom.value?.accessMode === 'private' ? Lock : Cloud);

const dialogElement = ref<HTMLElement | null>(null);
const nameElement = ref<HTMLInputElement | null>(null);
const projectPathInputElement = ref<HTMLInputElement | null>(null);
const confirmProjectElement = ref<HTMLButtonElement | null>(null);
const errorElement = ref<HTMLElement | null>(null);
const previousFocusElement = ref<HTMLElement | null>(null);
function requestClose() { if (props.canDismiss) emit('close'); }
function handleEscape() {
  if (!props.busy && visibleStep.value !== 'standalone') emit('back');
  else requestClose();
}
function handleDialogTab(event: KeyboardEvent) { trapFocusInDialog(event, dialogElement.value); }
function focusInitialControl() {
  const dialog = dialogElement.value;
  if (!dialog) return;
  const preferred = props.step === 'error' ? errorElement.value
    : visibleStep.value === 'standalone' ? (props.projectSelection ? confirmProjectElement.value : nameElement.value)
    : dialog.querySelector<HTMLElement>('.new-room-panel input:not(:disabled), .new-room-panel button:not(:disabled)');
  (preferred || dialog).focus({ preventScroll: true });
}
onMounted(async () => { previousFocusElement.value = currentFocusableElement(); await nextTick(); focusInitialControl(); });
onBeforeUnmount(() => restoreFocus(previousFocusElement.value));
watch(() => [visibleStep.value, props.projectSelection, props.busy] as const, async ([step, selection, busy], [previousStep, previousSelection, wasBusy]) => {
  if (step !== 'standalone') revealProject.value = false;
  else if (selection !== previousSelection) revealProject.value = Boolean(selection) && inputMode.value === 'pointer';
  await nextTick();
  if (busy) {
    if (!dialogElement.value?.contains(document.activeElement) || document.activeElement?.matches(':disabled')) {
      dialogElement.value?.focus({ preventScroll: true });
    }
  } else if (step !== previousStep || selection !== previousSelection || (wasBusy && document.activeElement === dialogElement.value)) {
    focusInitialControl();
  }
});
watch(() => props.projectPathError, async error => {
  if (!error || visibleStep.value !== 'project') return;
  await nextTick();
  projectPathInputElement.value?.focus({ preventScroll: true });
});
</script>

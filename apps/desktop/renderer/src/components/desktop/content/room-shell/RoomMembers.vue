<template>
  <section
    v-if="view !== 'hidden'"
    class="room-settings-section"
    data-section="members"
    aria-labelledby="room-settings-heading-members"
    data-testid="room-members"
  >
    <h3 id="room-settings-heading-members">Members</h3>

    <div v-if="view === 'github'" class="room-settings-list">
      <div class="room-settings-row" data-inline="true" data-testid="room-members-github">
        <div class="room-settings-row-copy">
          <p class="room-settings-row-title">Members are managed on GitHub</p>
          <p class="room-settings-row-description">People with a role on the repository can open this room. To add someone, ask a repository admin to add them on GitHub.</p>
        </div>
      </div>
    </div>

    <div v-else-if="view === 'error'" class="room-settings-list">
      <div class="room-settings-row" data-inline="true" data-testid="room-members-error">
        <div class="room-settings-row-copy">
          <p class="room-settings-row-title">Members could not load</p>
          <p class="room-settings-row-description" data-tone="error" role="alert">{{ error }}</p>
        </div>
        <div class="room-settings-row-action">
          <button class="room-settings-button" type="button" :disabled="busy" @click="load">Try again</button>
        </div>
      </div>
    </div>

    <template v-else-if="view === 'left'">
      <div class="room-settings-list">
        <div class="room-settings-row" data-inline="true" data-testid="room-members-left">
          <div class="room-settings-row-copy">
            <p class="room-settings-row-title">You left this room</p>
            <p class="room-settings-row-description">To come back, ask to join again. A room admin can let you in.</p>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="view === 'members'">
      <p v-if="error" class="room-settings-row-description room-members-error" data-tone="error" role="alert" data-testid="room-members-action-error">{{ error }}</p>

      <div v-if="requests.length" class="room-settings-list" data-testid="room-members-requests">
        <div
          v-for="request in requests"
          :key="request.id"
          class="room-settings-row room-member-row"
          data-inline="true"
          :data-testid="`room-join-request-${request.id}`"
        >
          <div class="room-member-identity">
            <ChatAvatar :name="request.display_name || request.login" :avatar-url="request.avatar_url" />
            <div class="room-settings-row-copy">
              <p class="room-settings-row-title">{{ request.display_name || request.login }} asks to join</p>
              <p class="room-settings-row-description">@{{ request.login }} · {{ askedLabel(request.created_at) }}</p>
            </div>
          </div>
          <div class="room-settings-row-action">
            <button class="room-settings-button" type="button" :disabled="busy" @click="decide(request, 'decline')">Decline</button>
            <button class="room-settings-button" type="button" data-variant="primary" :disabled="busy" @click="decide(request, 'approve')">Approve</button>
          </div>
        </div>
      </div>

      <div class="room-settings-list" data-testid="room-members-list">
        <div
          v-for="member in sortedMembers"
          :key="member.account_id"
          class="room-settings-row room-member-row"
          data-inline="true"
          :data-testid="`room-member-${member.account_id}`"
        >
          <div class="room-member-identity">
            <ChatAvatar :name="member.display_name || member.login" :avatar-url="member.avatar_url" />
            <div class="room-settings-row-copy">
              <p class="room-settings-row-title">
                {{ member.display_name || member.login }}
                <span v-if="member.account_id === viewerAccountId" class="room-member-you">You</span>
              </p>
              <p class="room-settings-row-description">@{{ member.login }} · {{ member.role === "admin" ? "Admin" : "Member" }}</p>
            </div>
          </div>
          <div class="room-settings-row-action">
            <template v-if="confirming?.accountId === member.account_id">
              <button class="room-settings-button" type="button" :disabled="busy" @click="confirming = null">Cancel</button>
              <button
                class="room-settings-button"
                type="button"
                data-variant="danger"
                :disabled="busy"
                :data-testid="`room-member-confirm-${member.account_id}`"
                @click="remove(member)"
              >{{ confirming.kind === "leave" ? "Leave room" : "Remove" }}</button>
            </template>
            <template v-else-if="member.account_id === viewerAccountId">
              <button
                class="room-settings-button"
                type="button"
                :disabled="busy"
                data-testid="room-member-leave"
                @click="confirming = { accountId: member.account_id, kind: 'leave' }"
              >Leave</button>
            </template>
            <template v-else-if="canManage">
              <button
                class="room-settings-button"
                type="button"
                :disabled="busy"
                @click="setRole(member, member.role === 'admin' ? 'member' : 'admin')"
              >{{ member.role === "admin" ? "Make member" : "Make admin" }}</button>
              <button
                class="room-settings-button"
                type="button"
                :disabled="busy"
                :data-testid="`room-member-remove-${member.account_id}`"
                @click="confirming = { accountId: member.account_id, kind: 'remove' }"
              >Remove</button>
            </template>
          </div>
        </div>
      </div>
      <p v-if="!canManage" class="room-settings-row-description">Only room admins can let people in or remove them.</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopRoomMembershipFailure,
  RoomJoinRequest,
  RoomMember,
  RoomMemberRole,
} from "../../../../../../electron/ipc-types";
import ChatAvatar from "../../../../../../../../shared/ui/ChatAvatar.vue";
import { desktopIpc } from "../../../../ipc/index";
import { roomJoinRequests } from "../../../../composables/useRoomJoinRequests";
import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";
import { joinAskedLabel } from "../auth-onboarding";
import { roomMembersSummary, roomMembershipErrorMessage, sortRoomMembers } from "./room-members";

const props = defineProps<{ roomIdentifier: string }>();
// The Room settings rail lists Members only while this block shows (null hides it).
const emit = defineEmits<{ summary: [summary: string | null] }>();

type View = "hidden" | "github" | "members" | "left" | "error";
const view = ref<View>("hidden");
const members = ref<RoomMember[]>([]);
const requests = ref<RoomJoinRequest[]>([]);
const canManage = ref(false);
const viewerAccountId = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const confirming = ref<{ accountId: string; kind: "remove" | "leave" } | null>(null);
let generation = 0;

const sortedMembers = computed(() => sortRoomMembers(members.value, viewerAccountId.value));
watch(
  () => roomMembersSummary(view.value, members.value.length, requests.value.length),
  (summary) => emit("summary", summary),
  { immediate: true },
);

function askedLabel(createdAt: string): string {
  return `asked ${joinAskedLabel(createdAt, Date.now())}`;
}

/** A server without member routes, a room kept on this computer, or a non-member shows nothing. */
function hiddenFor(result: DesktopRoomMembershipFailure): boolean {
  return result.status === 404 || result.status === 403 || result.code === "local_room";
}

async function load(): Promise<void> {
  const version = ++generation;
  busy.value = true;
  error.value = null;
  confirming.value = null;
  try {
    const list = await desktopIpc.roomMembers.list(props.roomIdentifier);
    if (version !== generation) return;
    if (!list.ok) {
      members.value = [];
      requests.value = [];
      if (hiddenFor(list)) {
        view.value = "hidden";
      } else {
        view.value = "error";
        error.value = list.message || "LetAgents could not load the members.";
      }
      return;
    }
    viewerAccountId.value = list.viewerAccountId;
    if (list.managedBy === "github") {
      members.value = [];
      requests.value = [];
      canManage.value = false;
      view.value = "github";
      return;
    }
    members.value = list.members;
    canManage.value = list.canManage;
    view.value = "members";
    if (!list.canManage) {
      requests.value = [];
      return;
    }
    const pending = await desktopIpc.roomMembers.listJoinRequests(props.roomIdentifier);
    if (version !== generation) return;
    requests.value = pending.ok ? pending.joinRequests.filter((request) => request.state === "pending") : [];
    if (!pending.ok) error.value = pending.message || "Requests to join could not load.";
  } catch (cause) {
    if (version !== generation) return;
    view.value = "error";
    error.value = safeUserVisibleErrorDetail(cause, "LetAgents could not load the members.");
  } finally {
    if (version === generation) busy.value = false;
  }
}

/** Runs one change for the room shown now; a result that lands after a room change is dropped. */
async function run(action: (current: () => boolean) => Promise<void>, fallback: string): Promise<void> {
  if (busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = null;
  try {
    await action(() => version === generation);
  } catch (cause) {
    if (version === generation) error.value = safeUserVisibleErrorDetail(cause, fallback);
  } finally {
    if (version === generation) busy.value = false;
  }
}

function decide(request: RoomJoinRequest, decision: "approve" | "decline"): Promise<void> {
  return run(async (current) => {
    const result = await desktopIpc.roomMembers.decideJoinRequest(props.roomIdentifier, request.id, decision);
    if (!current()) return;
    if (!result.ok && result.code !== "ROOM_JOIN_REQUEST_NOT_PENDING") {
      error.value = roomMembershipErrorMessage(result);
      return;
    }
    roomJoinRequests.forget(request.id);
    requests.value = requests.value.filter((item) => item.id !== request.id);
    // An approved person is a member now; another admin's decision may have added them too.
    if (decision === "approve" || !result.ok) {
      const list = await desktopIpc.roomMembers.list(props.roomIdentifier);
      if (current() && list.ok && list.managedBy === "letagents") members.value = list.members;
    }
  }, "The request could not be decided.");
}

function setRole(member: RoomMember, role: RoomMemberRole): Promise<void> {
  confirming.value = null;
  return run(async (current) => {
    const result = await desktopIpc.roomMembers.setRole(props.roomIdentifier, member.account_id, role);
    if (!current()) return;
    if (!result.ok) {
      error.value = roomMembershipErrorMessage(result);
      return;
    }
    members.value = members.value.map((item) => item.account_id === member.account_id ? result.member : item);
  }, "The role could not be changed.");
}

function remove(member: RoomMember): Promise<void> {
  const leaving = member.account_id === viewerAccountId.value;
  return run(async (current) => {
    const result = await desktopIpc.roomMembers.remove(props.roomIdentifier, member.account_id);
    if (!current()) return;
    confirming.value = null;
    if (!result.ok) {
      error.value = roomMembershipErrorMessage(result);
      return;
    }
    if (leaving) {
      members.value = [];
      requests.value = [];
      view.value = "left";
      return;
    }
    members.value = members.value.filter((item) => item.account_id !== member.account_id);
  }, leaving ? "You could not leave the room." : "The member could not be removed.");
}

// Loaded when the settings open (never during a server render) and again when the room changes.
onMounted(() => {
  void load();
  // Settings opening is one of the moments the Inbox list of requests is read again.
  void roomJoinRequests.refresh();
});
watch(() => props.roomIdentifier, () => { void load(); });
onBeforeUnmount(() => { generation++; });
</script>

<style scoped>
.room-member-row { align-items: center; }
.room-member-identity { display: flex; align-items: center; gap: 12px; min-width: 0; }
.room-member-you {
  margin-left: 6px;
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 500;
}
.room-members-error { padding: 0 2px; max-width: none; }
.room-settings-button[data-variant="danger"] { border-color: var(--red-dim); color: var(--red-text); }
</style>

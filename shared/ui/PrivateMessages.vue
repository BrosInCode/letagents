<template>
  <section
    class="private-messages"
    :class="{ 'chat-open': selectedId || composing }"
    aria-label="Private messages"
  >
    <aside class="conversation-list" aria-label="Conversations">
      <header class="conversation-list-heading">
        <h1>Messages</h1>
        <button
          class="chat-icon-button"
          title="New chat"
          aria-label="New chat"
          @click="newChat()"
        >
          <ChatIcon name="plus" />
        </button>
      </header>
      <label class="conversation-search"
        ><ChatIcon name="search" /><input
          v-model="filter"
          type="search"
          placeholder="Search conversations"
          aria-label="Search conversations"
      /></label>
      <div class="conversation-tabs" aria-label="Show conversations">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :aria-pressed="section === tab.id"
          @click="section = tab.id"
        >
          {{ tab.label
          }}<span v-if="tab.id === 'requests' && requests">{{ requests }}</span>
        </button>
      </div>
      <p v-if="loading" class="conversation-list-note" role="status">
        Loading conversations…
      </p>
      <div v-else-if="!visibleChats.length" class="conversation-list-empty">
        <ChatIcon name="chat" />
        <p>
          {{
            filter
              ? "No matching conversations"
              : section === "requests"
                ? "No message requests"
                : section === "archived"
                  ? "No archived chats"
                  : "Your conversations will appear here"
          }}
        </p>
        <button
          v-if="section === 'chats' && !filter"
          class="chat-text-button"
          @click="newChat()"
        >
          Start a chat
        </button>
      </div>
      <div class="conversation-rows">
        <button
          v-for="chat in visibleChats"
          :key="chat.id"
          class="conversation-row"
          :class="{ selected: selectedId === chat.id && !composing }"
          :aria-current="
            selectedId === chat.id && !composing ? 'true' : undefined
          "
          @click="selectChat(chat.id)"
        >
          <span
            class="conversation-avatar"
            :class="{ group: chat.members.length > 2 }"
            ><img
              v-if="avatar(chat)"
              :src="avatar(chat)!"
              alt=""
              referrerpolicy="no-referrer"
            /><ChatIcon v-else-if="chat.members.length > 2" name="users" /><span
              v-else
              >{{ title(chat).slice(0, 1).toUpperCase() }}</span
            ></span
          >
          <span class="conversation-row-content"
            ><span class="conversation-row-title"
              ><strong>{{ title(chat) }}</strong
              ><time v-if="chat.last_message">{{
                timeLabel(chat.last_message.created_at)
              }}</time></span
            ><span class="conversation-row-preview"
              ><span>{{
                chat.last_message
                  ? (chat.last_message.sender_account_id === accountId
                      ? "You: "
                      : "") + chat.last_message.text
                  : "Start the conversation"
              }}</span
              ><span
                v-if="chat.unread_count"
                class="conversation-unread"
                :aria-label="`${chat.unread_count} unread messages`"
                >{{ chat.unread_count > 99 ? "99+" : chat.unread_count }}</span
              ></span
            ></span
          >
        </button>
      </div>
      <div v-if="connectionError" class="conversation-connection" role="status">
        {{ connectionError
        }}<button class="chat-text-button" @click="refresh">Retry</button>
      </div>
    </aside>

    <section
      class="conversation-content"
      :aria-label="
        composing ? 'New chat' : selected ? title(selected) : 'Messages'
      "
    >
      <template v-if="composing">
        <header class="conversation-header">
          <button
            class="chat-icon-button"
            aria-label="Cancel new chat"
            @click="cancelCompose"
          >
            <ChatIcon name="back" />
          </button>
          <h2>{{ addingFrom ? "Add people" : "New chat" }}</h2>
        </header>
        <div class="conversation-compose-people">
          <label for="conversation-people-search">To</label>
          <div class="conversation-recipient-field">
            <span
              v-for="person in picked"
              :key="person.id"
              class="conversation-recipient"
              >{{ person.display_name || person.login
              }}<button
                v-if="!originalIds.includes(person.id)"
                class="chat-icon-button"
                :aria-label="`Remove ${person.display_name || person.login}`"
                @click="picked = picked.filter((item) => item.id !== person.id)"
              >
                <ChatIcon name="close" /></button></span
            ><input
              id="conversation-people-search"
              ref="peopleInput"
              v-model="peopleQuery"
              autocomplete="off"
              placeholder="Name or GitHub username"
              @keydown.esc="cancelCompose"
            />
          </div>
          <div class="conversation-people-results" aria-label="People">
            <p v-if="searching" role="status">Searching…</p>
            <p v-else-if="peopleQuery.trim().length > 1 && !people.length">
              No people found. Try their GitHub username.
            </p>
            <button
              v-for="person in people"
              :key="person.id"
              class="conversation-person"
              @click="pick(person)"
            >
              <span class="conversation-avatar"
                ><img
                  v-if="person.avatar_url"
                  :src="person.avatar_url"
                  alt=""
                  referrerpolicy="no-referrer"
                /><span v-else>{{
                  person.login.slice(0, 1).toUpperCase()
                }}</span></span
              ><span
                ><strong>{{ person.display_name || person.login }}</strong
                ><small>@{{ person.login }}</small></span
              ><ChatIcon name="plus" />
            </button>
          </div>
          <p class="conversation-compose-hint">
            {{
              addingFrom
                ? "This opens a chat with the people you choose. Earlier messages stay in the original chat."
                : "Choose one person, or bring a few people together."
            }}
          </p>
          <button
            class="chat-primary"
            :disabled="
              busy ||
              !picked.length ||
              Boolean(addingFrom && picked.length === originalIds.length)
            "
            @click="createChat"
          >
            {{ busy ? "Opening…" : "Open chat" }}
          </button>
          <p v-if="actionError" class="conversation-error" role="alert">
            {{ actionError }}
          </p>
        </div>
      </template>
      <template v-else-if="selected">
        <header class="conversation-header">
          <button
            class="chat-icon-button conversation-mobile-back"
            aria-label="Back to conversations"
            @click="selectedId = null"
          >
            <ChatIcon name="back" /></button
          ><button class="conversation-title-button" @click="showMembers">
            <h2>{{ title(selected) }}</h2>
            <span>{{
              selected.members.length === 2
                ? "Private conversation"
                : `${selected.members.length} people`
            }}</span>
          </button>
          <div class="conversation-header-actions">
            <button
              class="chat-icon-button"
              title="Add people"
              aria-label="Add people"
              :disabled="!selected.accepted"
              @click="newChat(selected)"
            >
              <ChatIcon name="plus" />
            </button>
            <details ref="menuDetails" class="conversation-menu">
              <summary class="chat-icon-button" aria-label="Chat options">
                <ChatIcon name="more" />
              </summary>
              <div>
                <button @click="updateSelected({ muted: !selected.muted })">
                  {{ selected.muted ? "Unmute" : "Mute" }} chat</button
                ><button
                  @click="updateSelected({ archived: !selected.archived })"
                >
                  {{ selected.archived ? "Restore" : "Archive" }} chat</button
                ><button @click="showMembers">View people</button>
              </div>
            </details>
          </div>
        </header>
        <div v-if="!selected.accepted" class="conversation-request">
          <div>
            <strong>{{ personName(selected.created_by) }} wants to chat</strong>
            <p>Accept to reply and add people.</p>
          </div>
          <button
            class="chat-primary"
            :disabled="busy"
            @click="updateSelected({ accept: true })"
          >
            Accept</button
          ><button
            class="chat-secondary"
            :disabled="busy"
            @click="block(selected.created_by, true)"
          >
            Block
          </button>
        </div>
        <div
          ref="messageList"
          class="conversation-timeline"
          role="log"
          aria-label="Messages"
          :aria-busy="messagesLoading"
          @scroll="rememberScroll"
        >
          <button
            v-if="hasMore"
            class="chat-text-button conversation-load-more"
            :disabled="messagesLoading"
            @click="loadEarlier"
          >
            Load earlier messages
          </button>
          <div
            v-if="messagesLoading && !messages.length"
            class="conversation-timeline-note"
            role="status"
          >
            Loading messages…
          </div>
          <div v-else-if="!messages.length" class="conversation-timeline-empty">
            <span class="conversation-empty-mark"
              ><ChatIcon name="chat"
            /></span>
            <h3>
              {{
                selected.members.length === 2
                  ? `Say hello to ${title(selected)}`
                  : "Start the conversation"
              }}
            </h3>
            <p>Only the people in this chat can read its messages.</p>
          </div>
          <template
            v-for="(message, index) in messages"
            :key="message.client_message_id + message.sender_account_id"
          >
            <div
              v-if="
                index === 0 ||
                dayLabel(messages[index - 1].created_at) !==
                  dayLabel(message.created_at)
              "
              class="conversation-day"
            >
              <span>{{ dayLabel(message.created_at) }}</span>
            </div>
            <article
              class="conversation-message"
              :class="{ own: message.sender_account_id === accountId }"
            >
              <div class="conversation-message-meta">
                <strong>{{
                  message.sender_account_id === accountId
                    ? "You"
                    : personName(message.sender_account_id)
                }}</strong
                ><time
                  :datetime="message.created_at"
                  :title="new Date(message.created_at).toLocaleString()"
                  >{{ clockLabel(message.created_at) }}</time
                >
              </div>
              <p>{{ message.text }}</p>
            </article>
          </template>
          <article
            v-if="outbox[selectedId!]"
            class="conversation-message own pending"
          >
            <div class="conversation-message-meta">
              <strong>You</strong
              ><span role="status">{{
                outbox[selectedId!].failed
                  ? "Not sent"
                  : outbox[selectedId!].acknowledgedNumber !== undefined
                    ? "Sent"
                    : "Sending…"
              }}</span>
            </div>
            <p>{{ outbox[selectedId!].text }}</p>
            <button
              v-if="outbox[selectedId!].failed"
              class="chat-text-button"
              @click="send"
            >
              Retry
            </button>
          </article>
        </div>
        <button
          v-if="newMessagesBelow"
          class="conversation-jump chat-secondary"
          @click="scrollBottom"
        >
          New messages <ChatIcon name="send" />
        </button>
        <div class="conversation-composer-wrap">
          <p v-if="actionError" class="conversation-error" role="alert">
            {{ actionError }}
            <button
              v-if="historyNeedsRetry"
              class="chat-text-button"
              @click="refresh"
            >
              Retry
            </button>
          </p>
          <p
            v-if="!selected.can_send && selected.accepted"
            class="conversation-waiting"
          >
            {{
              selected.members.some((member) => member.blocked)
                ? "Unblock this person to continue the conversation."
                : selected.members.every((member) => member.accepted)
                  ? "You can’t send messages in this chat."
                  : "You can send another message once everyone has accepted."
            }}
          </p>
          <form class="conversation-composer" @submit.prevent="send">
            <textarea
              ref="composer"
              v-model="draft"
              rows="2"
              maxlength="20000"
              :disabled="!selected.can_send || Boolean(outbox[selectedId!])"
              :placeholder="
                selected.can_send ? 'Write a message…' : 'Waiting to chat…'
              "
              aria-label="Message"
              @keydown="composerKeydown"
            /><button
              class="chat-send"
              type="submit"
              :disabled="
                !selected.can_send ||
                !draft.trim() ||
                Boolean(outbox[selectedId!])
              "
              aria-label="Send message"
            >
              <ChatIcon name="send" />
            </button>
          </form>
          <span class="conversation-composer-hint"
            >Enter to send · Shift + Enter for a new line</span
          >
        </div>
      </template>
      <div v-else class="conversation-welcome">
        <span class="conversation-empty-mark"><ChatIcon name="chat" /></span>
        <h2>A place to talk</h2>
        <p>
          Message someone directly, or start a conversation with a few people.
        </p>
        <button class="chat-primary" @click="newChat()">
          <ChatIcon name="plus" />New chat
        </button>
      </div>
    </section>
    <dialog
      ref="membersDialog"
      aria-label="People in this chat"
      class="conversation-members-dialog"
      @click="
        (event) => event.target === membersDialog && membersDialog?.close()
      "
    >
      <div v-if="selected">
        <header>
          <h2>People in this chat</h2>
          <button
            class="chat-icon-button"
            aria-label="Close people"
            @click="membersDialog?.close()"
          >
            <ChatIcon name="close" />
          </button>
        </header>
        <div
          v-for="member in selected.members"
          :key="member.id"
          class="conversation-member"
        >
          <span class="conversation-avatar"
            ><img
              v-if="member.avatar_url"
              :src="member.avatar_url"
              alt=""
              referrerpolicy="no-referrer"
            /><span v-else>{{
              member.login.slice(0, 1).toUpperCase()
            }}</span></span
          ><span
            ><strong>{{
              member.id === accountId
                ? "You"
                : member.display_name || member.login
            }}</strong
            ><small>{{
              member.accepted ? `@${member.login}` : "Invited"
            }}</small></span
          ><button
            v-if="member.id !== accountId && selected.members.length > 2"
            class="chat-text-button"
            :disabled="busy || member.blocked"
            @click="messagePerson(member.id)"
          >
            Message</button
          ><button
            v-if="member.id !== accountId"
            class="chat-text-button"
            :disabled="busy"
            @click="block(member.id, !member.blocked)"
          >
            {{ member.blocked ? "Unblock" : "Block" }}
          </button>
        </div>
      </div>
    </dialog>
  </section>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import type {
  Conversation,
  ConversationApi,
  ConversationMessage,
  ConversationPerson,
} from "../conversation-contracts.mjs";
import ChatIcon from "./ConversationIcon.vue";

const props = withDefaults(
  defineProps<{
    api: ConversationApi;
    accountId: string;
    active?: boolean;
    openConversationId?: string | null;
    openConversationNonce?: number;
  }>(),
  { active: true, openConversationId: null, openConversationNonce: 0 },
);
const emit = defineEmits<{ unread: [count: number] }>();
const chats = ref<Conversation[]>([]),
  selectedId = ref<string | null>(null),
  messages = ref<ConversationMessage[]>([]);
const section = ref("chats"),
  filter = ref(""),
  loading = ref(true),
  messagesLoading = ref(false),
  busy = ref(false);
const connectionError = ref(""),
  actionError = ref(""),
  historyNeedsRetry = ref(false),
  hasMore = ref(false),
  newMessagesBelow = ref(false);
const composing = ref(false),
  addingFrom = ref<string | undefined>(),
  originalIds = ref<string[]>([]),
  picked = ref<ConversationPerson[]>([]),
  peopleQuery = ref(""),
  people = ref<ConversationPerson[]>([]),
  searching = ref(false);
const messageList = ref<HTMLElement>(),
  composer = ref<HTMLTextAreaElement>(),
  peopleInput = ref<HTMLInputElement>(),
  membersDialog = ref<HTMLDialogElement>(),
  menuDetails = ref<HTMLDetailsElement>();
const drafts = ref<Record<string, string>>({});
const outbox = ref<
  Record<
    string,
    { text: string; id: string; failed: boolean; acknowledgedNumber?: number }
  >
>({});
let alive = true,
  version = "0",
  refreshGeneration = 0,
  messageGeneration = 0,
  searchGeneration = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined,
  retryTimer: ReturnType<typeof setTimeout> | undefined;
let atBottom = true;
const tabs = [
  { id: "chats", label: "Chats" },
  { id: "requests", label: "Requests" },
  { id: "archived", label: "Archived" },
];
const selected = computed(() =>
  chats.value.find((chat) => chat.id === selectedId.value),
);
const requests = computed(
  () => chats.value.filter((chat) => !chat.accepted && !chat.archived).length,
);
const visibleChats = computed(() =>
  chats.value.filter(
    (chat) =>
      (section.value === "archived"
        ? chat.archived
        : !chat.archived &&
          (section.value === "requests" ? !chat.accepted : chat.accepted)) &&
      title(chat).toLowerCase().includes(filter.value.toLowerCase()),
  ),
);
const draft = computed({
  get: () => drafts.value[selectedId.value || ""] || "",
  set: (value) => {
    if (selectedId.value) drafts.value[selectedId.value] = value;
  },
});
const title = (chat: Conversation) =>
  chat.members
    .filter((member) => member.id !== props.accountId)
    .map((member) => member.display_name || member.login)
    .join(", ");
const avatar = (chat: Conversation) =>
  chat.members.length === 2
    ? chat.members.find((member) => member.id !== props.accountId)?.avatar_url
    : null;
const personName = (id: string) => {
  const member = selected.value?.members.find((member) => member.id === id);
  return member?.display_name || member?.login || "Member";
};
const clockLabel = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayLabel = (at: string) =>
  new Date(at).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const timeLabel = (at: string) =>
  new Date(at).toDateString() === new Date().toDateString()
    ? clockLabel(at)
    : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      )
    : "Something went wrong. Try again.";

async function refresh() {
  const generation = ++refreshGeneration;
  try {
    const result = await props.api.list();
    if (!alive || generation !== refreshGeneration) return;
    chats.value = result.conversations;
    version = result.version;
    connectionError.value = "";
    emit(
      "unread",
      chats.value
        .filter((chat) => !chat.muted && !chat.archived)
        .reduce((sum, chat) => sum + chat.unread_count, 0),
    );
    if (selectedId.value && props.active && !composing.value)
      await loadMessages(false);
  } catch (error) {
    if (alive) connectionError.value = errorText(error);
  } finally {
    if (alive) loading.value = false;
  }
}
async function watchChanges() {
  let failures = 0;
  while (alive) {
    try {
      const change = await props.api.changes(version);
      if (!alive) return;
      if (change.version !== version || historyNeedsRetry.value)
        await refresh();
      failures = 0;
    } catch {
      if (!alive) return;
      connectionError.value = "Reconnecting to messages…";
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(
          resolve,
          Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)),
        );
      });
    }
  }
}
async function markRead(id: string, number: number) {
  if (
    !props.active ||
    composing.value ||
    !document.hasFocus() ||
    document.visibilityState === "hidden" ||
    id !== selectedId.value ||
    !atBottom
  )
    return;
  const chat = chats.value.find((chat) => chat.id === id);
  if (!chat?.unread_count) return;
  try {
    await props.api.update(id, { last_read_number: number });
  } catch {
    /* next foreground refresh retries the read cursor */
  }
}
async function loadMessages(reset: boolean) {
  const id = selectedId.value;
  if (!id) return;
  const generation = ++messageGeneration;
  messagesLoading.value = true;
  try {
    const previous = messages.value[messages.value.length - 1]?.number ?? 0;
    const incremental = !reset && messages.value.length > 0;
    let after = previous;
    do {
      const result = await props.api.messages(
        id,
        incremental ? { after } : undefined,
      );
      if (!alive || id !== selectedId.value || generation !== messageGeneration)
        return;
      if (!incremental) {
        messages.value = result.messages;
        hasMore.value = result.has_more;
      } else {
        const merged = new Map(
          messages.value.map((message) => [message.number, message]),
        );
        result.messages.forEach((message) =>
          merged.set(message.number, message),
        );
        messages.value = [...merged.values()].sort(
          (a, b) => a.number - b.number,
        );
      }
      if (!incremental || !result.has_more || !result.messages.length) break;
      after = result.messages[result.messages.length - 1].number;
    } while (alive);
    const pending = outbox.value[id];
    if (
      pending &&
      ((pending.acknowledgedNumber !== undefined &&
        (messages.value.at(-1)?.number ?? 0) >= pending.acknowledgedNumber) ||
        messages.value.some(
          (message) =>
            message.sender_account_id === props.accountId &&
            message.client_message_id === pending.id,
        ))
    )
      delete outbox.value[id];
    if (historyNeedsRetry.value) actionError.value = "";
    historyNeedsRetry.value = false;
    await nextTick();
    if (reset || atBottom) await scrollBottom();
    else if (
      (messages.value[messages.value.length - 1]?.number ?? 0) > previous
    )
      newMessagesBelow.value = true;
    if (generation === messageGeneration)
      await markRead(
        id,
        messages.value[messages.value.length - 1]?.number ?? 0,
      );
  } catch (error) {
    if (id === selectedId.value && generation === messageGeneration) {
      historyNeedsRetry.value = true;
      actionError.value = errorText(error);
    }
  } finally {
    if (generation === messageGeneration) messagesLoading.value = false;
  }
}
async function selectChat(id: string) {
  selectedId.value = id;
  composing.value = false;
  actionError.value = "";
  messages.value = [];
  historyNeedsRetry.value = false;
  atBottom = true;
  newMessagesBelow.value = false;
  await loadMessages(true);
  await nextTick();
  if (alive && id === selectedId.value) composer.value?.focus();
}
async function loadEarlier() {
  const id = selectedId.value,
    first = messages.value[0]?.number;
  if (!id || !first || messagesLoading.value) return;
  const generation = ++messageGeneration;
  messagesLoading.value = true;
  const height = messageList.value?.scrollHeight ?? 0;
  try {
    const result = await props.api.messages(id, { before: first });
    if (!alive || id !== selectedId.value || generation !== messageGeneration)
      return;
    messages.value = [...result.messages, ...messages.value];
    hasMore.value = result.has_more;
    await nextTick();
    if (messageList.value)
      messageList.value.scrollTop += messageList.value.scrollHeight - height;
  } catch (error) {
    if (generation === messageGeneration) actionError.value = errorText(error);
  } finally {
    if (generation === messageGeneration) messagesLoading.value = false;
  }
}
function rememberScroll() {
  const element = messageList.value;
  if (!element) return;
  atBottom =
    element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  if (atBottom) {
    newMessagesBelow.value = false;
    if (selectedId.value)
      void markRead(
        selectedId.value,
        messages.value[messages.value.length - 1]?.number ?? 0,
      );
  }
}
async function scrollBottom() {
  await nextTick();
  if (messageList.value)
    messageList.value.scrollTop = messageList.value.scrollHeight;
  atBottom = true;
  newMessagesBelow.value = false;
}
async function newChat(from?: Conversation) {
  actionError.value = "";
  composing.value = true;
  addingFrom.value = from?.id;
  picked.value =
    from?.members.filter((member) => member.id !== props.accountId) ?? [];
  originalIds.value = picked.value.map((person) => person.id);
  peopleQuery.value = "";
  people.value = [];
  await nextTick();
  peopleInput.value?.focus();
}
function cancelCompose() {
  composing.value = false;
  actionError.value = "";
}
function pick(person: ConversationPerson) {
  if (!picked.value.some((item) => item.id === person.id))
    picked.value.push(person);
  peopleQuery.value = "";
  people.value = [];
  peopleInput.value?.focus();
}
watch(peopleQuery, (query) => {
  const generation = ++searchGeneration;
  clearTimeout(searchTimer);
  people.value = [];
  searching.value = false;
  if (query.trim().length < 2) return;
  searching.value = true;
  searchTimer = setTimeout(async () => {
    try {
      const result = await props.api.people(query);
      if (alive && generation === searchGeneration)
        people.value = result.people.filter(
          (person) => !picked.value.some((item) => item.id === person.id),
        );
    } catch (error) {
      if (generation === searchGeneration) actionError.value = errorText(error);
    } finally {
      if (generation === searchGeneration) searching.value = false;
    }
  }, 180);
});
async function createChat() {
  if (busy.value) return;
  busy.value = true;
  actionError.value = "";
  try {
    const result = await props.api.create(
      picked.value.map((person) => person.id),
      addingFrom.value,
    );
    await refresh();
    section.value = chats.value.find(
      (chat) => chat.id === result.conversation_id,
    )?.accepted
      ? "chats"
      : "requests";
    await selectChat(result.conversation_id);
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
async function updateSelected(
  changes: Parameters<ConversationApi["update"]>[1],
) {
  const id = selectedId.value;
  if (!id || busy.value) return;
  busy.value = true;
  actionError.value = "";
  try {
    await props.api.update(id, changes);
    if (menuDetails.value) menuDetails.value.open = false;
    if (changes.accept) section.value = "chats";
    if (changes.archived) selectedId.value = null;
    await refresh();
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
async function block(id: string, blocked: boolean) {
  if (busy.value) return;
  busy.value = true;
  actionError.value = "";
  try {
    await props.api.block(id, blocked);
    await refresh();
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
async function messagePerson(id: string) {
  if (busy.value) return;
  busy.value = true;
  actionError.value = "";
  try {
    const result = await props.api.create([id]);
    membersDialog.value?.close();
    await refresh();
    section.value = chats.value.find(
      (chat) => chat.id === result.conversation_id,
    )?.accepted
      ? "chats"
      : "requests";
    await selectChat(result.conversation_id);
  } catch (error) {
    actionError.value = errorText(error);
    membersDialog.value?.close();
  } finally {
    busy.value = false;
  }
}
async function showMembers() {
  await nextTick();
  membersDialog.value?.showModal();
}
function composerKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
async function send() {
  const id = selectedId.value;
  if (!id) return;
  let pending = outbox.value[id];
  if (pending && !pending.failed) return;
  if (!pending) {
    if (!draft.value.trim() || !selected.value?.can_send) return;
    pending = {
      text: draft.value.trim(),
      id: crypto.randomUUID(),
      failed: false,
    };
    outbox.value[id] = pending;
    draft.value = "";
  }
  pending.failed = false;
  actionError.value = "";
  await scrollBottom();
  try {
    const acknowledged = await props.api.send(id, pending.text, pending.id);
    if (outbox.value[id]?.id === pending.id)
      outbox.value[id].acknowledgedNumber = acknowledged.number;
    // Only fetched history advances the pagination/read cursor. Another person
    // may have sent a message immediately before this acknowledgement.
    // Keep the optimistic entry until loadMessages observes its client ID.
    await refresh();
    if (alive && id === selectedId.value) {
      await scrollBottom();
      await nextTick();
      composer.value?.focus();
    }
  } catch (error) {
    if (outbox.value[id]?.id === pending.id) outbox.value[id].failed = true;
    if (id === selectedId.value) actionError.value = errorText(error);
  }
}
function foreground() {
  if (document.visibilityState === "visible" && props.active) void refresh();
}
watch(
  () => props.active,
  (active) => {
    if (active) void refresh();
  },
);
watch(
  () => [props.openConversationId, props.openConversationNonce] as const,
  ([id]) => {
    if (id) void selectChat(id);
  },
);
onMounted(async () => {
  await refresh();
  if (!alive) return;
  if (props.openConversationId) await selectChat(props.openConversationId);
  if (!alive) return;
  void watchChanges();
  document.addEventListener("visibilitychange", foreground);
  window.addEventListener("focus", foreground);
});
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(searchTimer);
  clearTimeout(retryTimer);
  document.removeEventListener("visibilitychange", foreground);
  window.removeEventListener("focus", foreground);
});
</script>
<style scoped src="./private-messages.css"></style>

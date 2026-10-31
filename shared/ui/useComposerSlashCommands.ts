import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { completeSlashCommand, decideComposerSubmitAction, resolveSlashInput, type SlashCommand, type SlashPlatform } from '../slash-commands.mjs';

/** One send gate for keyboard and button submission in both main composers. */
export function useComposerSlashCommands(options: {
  text: Ref<string>;
  platform: SlashPlatform;
  scope: () => string | null | undefined;
  hasAttachments: () => boolean;
  isReply: () => boolean;
  run: (command: SlashCommand, argument: string) => boolean | Promise<boolean>;
  focus: () => void;
  onError: () => void;
}) {
  const dismissed = ref(false);
  const activeIndex = ref(0);
  const busy = ref(false);
  let revision = 0;
  onScopeDispose(() => { revision++; });
  watch([() => options.text.value, options.scope, options.hasAttachments, options.isReply], () => {
    revision++;
    dismissed.value = false;
    activeIndex.value = 0;
  }, { flush: 'sync' });
  const context = () => ({
    text: options.text.value,
    platform: options.platform,
    hasAttachments: options.hasAttachments(),
    isReply: options.isReply(),
    menuDismissed: dismissed.value,
    selectedCommandIndex: activeIndex.value,
  });
  const resolution = computed(() => resolveSlashInput(context()));
  const commands = computed(() => {
    const result = resolution.value;
    return result.kind === 'none' ? [] : result.kind === 'menu' ? result.commands : [result.command];
  });
  const open = computed(() => commands.value.length > 0);
  const hint = computed(() => resolution.value.kind === 'invalid' ? resolution.value.hint : '');
  const candidates = computed(() => commands.value.map(command => ({
    key: `slash-${command.name}`, label: command.usage, meta: command.description,
  })));

  function complete(index = activeIndex.value) {
    const command = commands.value[index];
    if (!command || busy.value) return;
    // Tab/click complete only the name, retaining any argument already entered.
    if (resolution.value.kind === 'menu' || !/\s/.test(options.text.value)) {
      options.text.value = completeSlashCommand(command);
    }
    options.focus();
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (!open.value || event.isComposing) return false;
    if (event.key === 'Escape') dismissed.value = true;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      activeIndex.value = (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + commands.value.length) % commands.value.length;
    } else if (event.key === 'Tab') complete();
    else return false;
    event.preventDefault();
    return true;
  }

  async function submit(sendMessage: () => unknown | Promise<unknown>) {
    if (busy.value) return;
    const decision = decideComposerSubmitAction(context());
    if (decision.action === 'send_message') {
      await sendMessage();
      return;
    }
    if (decision.action === 'complete_command') {
      options.text.value = decision.text;
      options.focus();
      return;
    }
    if (decision.action === 'show_hint') return;
    const submittedRevision = revision;
    busy.value = true;
    try {
      const succeeded = await options.run(decision.command, decision.argument);
      // A late task response must not erase edits or another room's draft.
      if (succeeded && revision === submittedRevision) options.text.value = '';
    } catch {
      options.onError();
    } finally {
      busy.value = false;
    }
  }

  return { open, candidates, activeIndex, hint, busy, complete, handleKey, submit };
}

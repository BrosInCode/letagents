// Local composer commands. Unknown slash-prefixed text remains an ordinary message.
export const SLASH_COMMANDS = Object.freeze([
  Object.freeze({ name: 'task', usage: '/task <title>', description: 'Create a task on the board', argument: 'required', platforms: ['desktop', 'web'] }),
  Object.freeze({ name: 'search', usage: '/search <query>', description: 'Search messages in this room', argument: 'required', platforms: ['desktop', 'web'] }),
  Object.freeze({ name: 'agent', usage: '/agent', description: 'Add an agent to this room', argument: 'none', platforms: ['desktop'] }),
]);

export function getSlashCommands(platform) {
  return SLASH_COMMANDS.filter(command => command.platforms.includes(platform));
}

export function resolveSlashInput({ text, platform, hasAttachments, isReply, menuDismissed }) {
  if (!text.startsWith('/') || /[\r\n]/.test(text) || hasAttachments || isReply || menuDismissed) {
    return { kind: 'none' };
  }
  const match = /^\/([^\s]*)(?:\s+(.*))?$/.exec(text);
  if (!match) return { kind: 'none' };
  const name = match[1].toLowerCase();
  const commands = getSlashCommands(platform);
  const command = commands.find(candidate => candidate.name === name);
  if (!command) {
    const matches = match[2] === undefined ? commands.filter(candidate => candidate.name.startsWith(name)) : [];
    return matches.length ? { kind: 'menu', commands: matches } : { kind: 'none' };
  }
  const argument = (match[2] ?? '').trim();
  if (command.argument === 'required' && !argument) {
    return { kind: 'invalid', command, hint: command.name === 'task' ? 'Add a task title' : 'Add a search query' };
  }
  if (command.argument === 'none' && argument) {
    return { kind: 'invalid', command, hint: '/agent does not take arguments' };
  }
  return { kind: 'execute', command, argument };
}

export function completeSlashCommand(command) {
  return `/${command.name}${command.argument === 'required' ? ' ' : ''}`;
}

export function decideComposerSubmitAction(input) {
  const resolution = resolveSlashInput(input);
  if (resolution.kind === 'none') return { action: 'send_message' };
  if (resolution.kind === 'menu') {
    const command = resolution.commands[input.selectedCommandIndex ?? 0] ?? resolution.commands[0];
    return { action: 'complete_command', text: completeSlashCommand(command) };
  }
  if (resolution.kind === 'invalid') return { action: 'show_hint', hint: resolution.hint };
  return { action: 'execute_command', command: resolution.command, argument: resolution.argument };
}

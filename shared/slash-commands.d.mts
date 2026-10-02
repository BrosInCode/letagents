export type SlashPlatform = 'desktop' | 'web';
export interface SlashCommand {
  readonly name: 'task' | 'search' | 'agent';
  readonly usage: string;
  readonly description: string;
  readonly argument: 'required' | 'none';
  readonly platforms: readonly SlashPlatform[];
}
export interface SlashInputContext {
  text: string;
  platform: SlashPlatform;
  hasAttachments?: boolean;
  isReply?: boolean;
  menuDismissed?: boolean;
  selectedCommandIndex?: number;
}
export type SlashResolution =
  | { kind: 'none' }
  | { kind: 'menu'; commands: readonly SlashCommand[] }
  | { kind: 'invalid'; command: SlashCommand; hint: string }
  | { kind: 'execute'; command: SlashCommand; argument: string };
export type ComposerSubmitDecision =
  | { action: 'send_message' }
  | { action: 'complete_command'; text: string }
  | { action: 'show_hint'; hint: string }
  | { action: 'execute_command'; command: SlashCommand; argument: string };
export declare const SLASH_COMMANDS: readonly SlashCommand[];
export declare function getSlashCommands(platform: SlashPlatform): readonly SlashCommand[];
export declare function resolveSlashInput(context: SlashInputContext): SlashResolution;
export declare function completeSlashCommand(command: SlashCommand): string;
export declare function decideComposerSubmitAction(context: SlashInputContext): ComposerSubmitDecision;

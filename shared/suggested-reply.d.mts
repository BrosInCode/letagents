/** The longest suggested reply an agent may attach to a message. */
export declare const SUGGESTED_REPLY_MAX_CHARS: 500;
export declare function validReplySuggestionIntent(value: unknown): value is { text: string | null };
export declare function replySuggestionText(value: unknown): string | null;

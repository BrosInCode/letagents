export const POSTGRES_INTEGER_MAX: number;
export const MESSAGE_SENDER_MAX_CODE_POINTS: number;
export const MESSAGE_SENDER_MAX_UTF8_BYTES: number;
export function parsePositivePgIntegerScopedId(value: unknown, prefix: string): number | null;
export function isMessageSenderWithinBounds(sender: unknown): sender is string;
export type ParsedAccountAgentRouting =
  | { version: 1; authority: "invalid" }
  | {
      version: 1;
      authority: "receipts";
      recipientAgentKeys: string[];
      recipientSessions: Array<{
        agentKey: string;
        agentSessionId: string;
        successorAgentSessionId?: string;
      }>;
      controlAuthorized: boolean;
    }
  | {
      version: 1;
      authority: "legacy";
      recipientAgentKeys: string[];
      recipientSessions: Array<{
        agentKey: string;
        agentSessionId: string;
        activationReason: string;
      }>;
      controlAuthorized: boolean;
    };
export function parseAccountAgentRoutingEnvelope(
  routing: unknown,
): ParsedAccountAgentRouting | undefined;

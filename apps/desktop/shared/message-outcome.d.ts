/** Bounded text evidence captured at dispatch preparation, never reconstructed from current room state. */
export interface PreparedRoomContext {
  preparedAt: string;
  totalMessages: number;
  omittedMessages: number;
  messages: Array<{ id: string | null; sender: string | null; text: string | null; truncated: boolean }>;
}

/** Only the latest retained control journal, exactly bound to this inbox item. */
export interface MessageIntervention {
  actionId: string;
  recordedAt: string;
  hasCorrection: boolean;
  correctionText: string | null;
  strategy: "native" | "stop_then_resend" | null;
  operatorResolution: "applied" | "not_applied" | null;
  status: "prepared" | "dispatching" | "completed" | "retryable" | "uncertain";
  interrupted: boolean | null;
  resumed: boolean | null;
}

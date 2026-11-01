export interface AskAgentModel {
  providerId: string;
  model: string | null;
  label: string;
}

export interface AskAgentInput {
  roomId: string;
  newRoomName: string;
  providerId: string;
  model: string | null;
  amountPercent: number | null;
  note: string;
}

export interface DesktopSupervisorGrantMetadata {
  grantId: string;
  hostId: string;
  installationId: string;
  allowedRoomIds: string[];
  allowedAgentKeys: string[];
  generation: number;
  expiresAt: string;
}

export interface DesktopProvisionSupervisorGrantInput {
  hostId: string;
  installationId: string;
  allowedRoomIds: string[];
  allowedAgentKeys: string[];
  ttlMs?: number;
}

export interface DesktopSecureStorageStatus {
  available: boolean;
  detail: string;
  canOpenCredentialStorage: boolean;
}

export interface AntigravityLane {
  laneId: string;
  model: string | null;
  displayName: string | null;
  percentRemaining: number;
  resetAt: string | null;
  lastEventAt: string | null;
}

export interface AntigravityQuotaDocument {
  version: number;
  observedAt: string | null;
  lanes: AntigravityLane[];
}

export interface AntigravityAdapterOptions {
  /** Override the home dir for tests. */
  homeDirOverride?: string;
  /** Extra absolute paths to consider as quota documents. */
  additionalPaths?: string[];
  /** Restrict snapshot reads to a subset of lane ids or model names. */
  laneFilter?: string[];
  /** Maximum file size to read. Default 1 MiB. */
  maxFileBytes?: number;
}

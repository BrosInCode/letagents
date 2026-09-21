/** A host-authored tool permission applies to this agent/project, not to arbitrary filesystem paths. */
export type HostToolScope = {
  agentId: string; accountId: string; projectId: string; projectName: string; sourceRepoPath: string;
  canonicalSourcePath: string; repository: string; remoteUrl: string;
  provider: "codex" | "claude-code" | "open-model"; toolId: string; toolLabel: string; policySha256: string;
};
export type HostToolRule = { id: string; revision: number; ownerId: string; scope: HostToolScope; createdAtMs: number };

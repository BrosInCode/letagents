/** The part of a leased branch's name that names the agent. */
export function agentBranchSegment(agentKey: string): string;
export function leasedBranchRef(taskId: string, agentKey: string): string;
/** True when `branch` is a branch LetAgents would lease to this agent, for any task. */
export function isAgentBranch(branch: unknown, agentKey: unknown): boolean;

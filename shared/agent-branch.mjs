/**
 * The branches LetAgents leases to an agent: `letagents/<task>/<agent>`. The
 * server names a task's branch with this module, and the desktop uses it to
 * tell an agent's own branches from every other branch.
 */

/** The part of a leased branch's name that names the agent. */
export function agentBranchSegment(agentKey) {
  const slug = agentKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "agent";
}

export function leasedBranchRef(taskId, agentKey) {
  return `letagents/${taskId}/${agentBranchSegment(agentKey)}`;
}

/** True when `branch` is a branch LetAgents would lease to this agent, for any task. */
export function isAgentBranch(branch, agentKey) {
  if (typeof branch !== "string" || typeof agentKey !== "string" || !agentKey.trim()) return false;
  const [prefix, task, agent, ...rest] = branch.split("/");
  return prefix === "letagents" && rest.length === 0 && typeof task === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task)
    && agent === agentBranchSegment(agentKey);
}

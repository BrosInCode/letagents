/** Words for how LetAgents last saw an agent, from its liveness capability. */
export function livenessCapabilityLabel(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'codex_app_server_runtime_stream') return 'Codex activity'
  if (normalized === 'session_activity') return 'Agent activity'
  if (normalized === 'process_observed') return 'Agent app detected'
  if (normalized === 'tool_bridge_only') return 'Tool connection'
  return 'Connection update'
}

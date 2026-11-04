import type {
  WakeRule,
  WakeRuleTestResult,
  WakeWebhookAgent,
  WakeWebhookApi,
  WakeWebhookFormInput,
} from '../../../../shared/wake-rules.mjs'
import { roomPath } from './room/api'
import { publishWakeRuleInvalidation } from './roomWakeRuleInvalidation'
import { cancelRoomWakeRule, isWakeRule, requestWakeRuleJson } from './roomWakeRules'

const RULE_ID = /^wake_[a-z0-9]{1,40}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isWakeWebhookAgent(value: unknown): value is WakeWebhookAgent {
  return isRecord(value)
    && typeof value.agent_key === 'string' && value.agent_key.length > 0
    && typeof value.agent_name === 'string'
    && typeof value.live === 'boolean'
    && typeof value.last_seen_at === 'string'
}

/** The signed-in person's own agents in the room: the form's agent picker. */
export async function fetchOwnedWakeAgents(roomIdentifier: string): Promise<WakeWebhookAgent[]> {
  const body = await requestWakeRuleJson(
    `${roomPath(roomIdentifier)}/wake-rules/my-agents`,
    {},
    'Your agents in this room could not be loaded.',
  )
  const agents = isRecord(body) ? body.agents : null
  return Array.isArray(agents) ? agents.filter(isWakeWebhookAgent) : []
}

/** Add (or renew) a webhook wake-up for one of the person's own agents. The URL, secret and key are sent once and never read back. */
export async function addRoomWakeWebhookRule(
  roomIdentifier: string,
  agentKey: string,
  input: WakeWebhookFormInput,
): Promise<{ rule: WakeRule; created: boolean }> {
  const rule = {
    event: 'room.message',
    ...(input.note ? { note: input.note } : {}),
    webhook: { url: input.url, secret: input.secret, ...(input.bearer ? { bearer: input.bearer } : {}) },
  }
  const body = await requestWakeRuleJson(
    `${roomPath(roomIdentifier)}/wake-rules`,
    { method: 'POST', body: JSON.stringify({ agent_key: agentKey, rule }) },
    'The wake-up could not be saved. Try again.',
  )
  const saved = isRecord(body) ? body.rule : null
  if (!isWakeRule(saved)) throw new Error('The wake-up could not be saved. Try again.')
  return { rule: saved, created: isRecord(body) && body.created === true }
}

/** One test delivery; the server answers once the receiver has (at most 10 s). */
export async function testRoomWakeRule(roomIdentifier: string, ruleId: string): Promise<WakeRuleTestResult> {
  if (!RULE_ID.test(ruleId)) throw new Error('The test could not be sent.')
  const body = await requestWakeRuleJson(
    `${roomPath(roomIdentifier)}/wake-rules/${encodeURIComponent(ruleId)}/test`,
    { method: 'POST', body: '{}' },
    'The test could not be sent.',
  )
  if (!isRecord(body) || typeof body.status !== 'number') throw new Error('The test could not be sent.')
  return {
    status: body.status,
    error_class: typeof body.error_class === 'string' ? body.error_class : null,
    delivery_id: typeof body.delivery_id === 'string' ? body.delivery_id : null,
  }
}

/** The form's transport for the web app. Every change tells the room's other views to re-read the rules. */
export const roomWakeWebhookApi: WakeWebhookApi = {
  listAgents: fetchOwnedWakeAgents,
  async add(roomId, agentKey, input) {
    const result = await addRoomWakeWebhookRule(roomId, agentKey, input)
    publishWakeRuleInvalidation(roomId)
    return result
  },
  async test(roomId, ruleId) {
    const result = await testRoomWakeRule(roomId, ruleId)
    publishWakeRuleInvalidation(roomId)
    return result
  },
  async cancel(roomId, ruleId) {
    const rule = await cancelRoomWakeRule(roomId, ruleId)
    publishWakeRuleInvalidation(roomId)
    return rule
  },
}

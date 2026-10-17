import { reactive } from 'vue'

export type TopologyModeId = 'symbiosis' | 'lending' | 'swarm'
export type HemisphereFocus = 'human' | 'fused' | 'agent'
export type SiteTheme = 'dark' | 'light'

export const symbiosisBridge = reactive({
  /** -1 = Human (Organic Left), 0 = Fused Equilibrium, +1 = Agent (Symbiote Right) */
  biasTarget: 0,
  focus: 'fused' as HemisphereFocus,
  activeChapter: 0,
  symbiosisAct: 0,
  theme: 'light' as SiteTheme,
})

export function setHemisphereFocus(focus: HemisphereFocus) {
  symbiosisBridge.focus = focus
  symbiosisBridge.biasTarget = focus === 'human' ? -1 : focus === 'agent' ? 1 : 0
}

export function syncThemeFromDom(): SiteTheme {
  if (typeof document === 'undefined') return symbiosisBridge.theme
  const attr = document.documentElement.getAttribute('data-theme')
  let stored: string | null = null
  try {
    stored = typeof localStorage !== 'undefined' ? localStorage.getItem('lac-theme') : null
  } catch { /* ignore */ }
  const resolved: SiteTheme =
    attr === 'dark' || (!attr && stored === 'dark') ? 'dark' : 'light'
  symbiosisBridge.theme = resolved
  document.documentElement.setAttribute('data-theme', resolved)
  return resolved
}

export function toggleTheme(): SiteTheme {
  const next: SiteTheme = symbiosisBridge.theme === 'light' ? 'dark' : 'light'
  symbiosisBridge.theme = next
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('theme-transitioning')
    document.documentElement.setAttribute('data-theme', next)
    window.setTimeout(() => {
      document.documentElement.classList.remove('theme-transitioning')
    }, 520)
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('lac-theme', next)
    }
  } catch { /* ignore */ }
  return next
}

export interface TopologyMode {
  id: TopologyModeId
  code: string
  label: string
  tagline: string
  description: string
  telemetry: {
    key: string
    value: string
    tone: 'human' | 'agent' | 'neutral'
  }[]
}

export const TOPOLOGY_MODES: TopologyMode[] = [
  {
    id: 'symbiosis',
    code: '01',
    label: 'Symbiosis',
    tagline: 'Intent from humans. Velocity from agents. Shared in one living room.',
    description:
      'Humans bring architectural judgment, task acceptance, and sovereign host approvals. Agents bring parallel execution, workspace diff captures, and cross-IDE verification.',
    telemetry: [
      { key: 'IDENTITY_NAMESPACE', value: 'owner/agent_name', tone: 'human' },
      { key: 'WIRE_TRANSPORT', value: 'MCP + DAEMON_IPC', tone: 'agent' },
      { key: 'WORKSPACE_DIFF', value: 'ATTRIBUTED_CAPTURE', tone: 'agent' },
      { key: 'HOST_AUTHORITY', value: 'SOVEREIGN_APPROVAL_JOURNAL', tone: 'human' },
    ],
  },
  {
    id: 'lending',
    code: '02',
    label: 'Share Agent',
    tagline: 'They get the repo job you share — never your machine.',
    description:
      'Turn idle Claude Code, Codex, Cursor, or Antigravity quota into bounded, metered room workers. Output-bound permissions and instant revocation keep every handoff sovereign.',
    telemetry: [
      { key: 'CAPABILITY_LANE', value: 'OUTPUT_BOUND (draft_pr)', tone: 'human' },
      { key: 'BRANCH_FENCE', value: 'letagents/<task>/<agent>', tone: 'agent' },
      { key: 'QUOTA_METER', value: 'NativeQuotaSnapshot + LRT', tone: 'agent' },
      { key: 'SECRET_SCAN', value: 'PASSED · 0 EXPOSED', tone: 'human' },
    ],
  },
  {
    id: 'swarm',
    code: '03',
    label: 'Agent Swarms',
    tagline: 'Prefix any repo URL with letagents.chat/ and unleash a coordinated swarm.',
    description:
      'Multiple humans and heterogeneous agents converge on a repository across Git Rooms, Branch Rooms, and Focus Rooms—governed by work leases and SHA-fenced review journals.',
    telemetry: [
      { key: 'ROOM_LOCATOR', value: 'letagents.chat/github.com/org/repo', tone: 'neutral' },
      { key: 'REVIEW_RULE', value: 'NEVER_SELF_REVIEW', tone: 'human' },
      { key: 'EFFECT_JOURNAL', value: '40-HEX COMMIT_SHA FENCE', tone: 'agent' },
      { key: 'GITHUB_GATE', value: 'letagents-lease REQUIRED', tone: 'agent' },
    ],
  },
]

export interface SymbiosisExchangeStep {
  id: string
  index: string
  phase: string
  title: string
  summary: string
  humanActor: {
    handle: string
    role: string
    surface: string
    actionTitle: string
    actionDetail: string
    badge: string
  }
  agentActor: {
    handle: string
    runtime: string
    toolCall: string
    payload: string
    stateTransition: string
  }
  invariant: string
}

export const SYMBIOSIS_EXCHANGE_STEPS: SymbiosisExchangeStep[] = [
  {
    id: 'intent',
    index: '01',
    phase: 'ARCHITECTURAL INTENT',
    title: 'Human frames the problem; the room locks the contract',
    summary:
      'A human architect proposes or accepts a task on the room board. Repository content is treated strictly as task input—never as permission authority.',
    humanActor: {
      handle: '@emmyleke',
      role: 'Repo Admin · Human Architect',
      surface: 'Desktop Supervisor & Web Room',
      actionTitle: 'Accepts task_108 & sets acceptance criteria',
      actionDetail:
        'Moves task_108 ("Harden cursor crash recovery behind blocked room deliveries") from proposed → accepted on the canonical board.',
      badge: 'SOVEREIGN_ADMIN',
    },
    agentActor: {
      handle: 'emmyleke/claude-code',
      runtime: 'Claude Code · Local Subscription',
      toolCall: 'wait_for_messages(after_message_id="msg_418")',
      payload: `{
  "room_id": "github.com/brosincode/letagents",
  "task_id": "task_108",
  "status": "accepted",
  "last_observed_message_id": "msg_419"
}`,
      stateTransition: 'proposed → accepted (claimable)',
    },
    invariant: 'Agent-created tasks require coordinator acceptance before any worker can claim a lease.',
  },
  {
    id: 'claim',
    index: '02',
    phase: 'LEASE & WORKSPACE CAPTURE',
    title: 'Your local subscription claims the lease and snapshots the tree',
    summary:
      'Before touching a single line of code, the agent acquires an exclusive work lease and records a baseline file snapshot so every diff is provably attributed.',
    humanActor: {
      handle: '@emmyleke',
      role: 'Supervisor Host Owner',
      surface: 'Execution Approval Journal',
      actionTitle: 'Grants scoped workspace fence',
      actionDetail:
        'Desktop daemon binds worker_runtime_custody to the active branch worktree with zero extra API keys or middleman token markup.',
      badge: 'LEASE_GRANTED',
    },
    agentActor: {
      handle: 'emmyleke/claude-code',
      runtime: 'Claude Code · Supervised Daemon',
      toolCall: 'claim_task + begin_workspace_capture',
      payload: `claim_task(task_id="task_108")
begin_workspace_capture(
  worker_id="worker_9f2a",
  room_id="github.com/brosincode/letagents",
  cwd="/worktrees/cursor-recovery"
) -> capture_id="cap_77d1"`,
      stateTransition: 'accepted → assigned → in_progress',
    },
    invariant: 'One active work lease per task prevents concurrent agents from colliding on the same files.',
  },
  {
    id: 'lend',
    index: '03',
    phase: 'COMPUTE LENDING & HANDOFF',
    title: 'Another builder lends their idle Codex agent to accelerate the sprint',
    summary:
      'When a teammate hits a quota window or needs parallel test coverage, a peer lends their idle agent under an output-bound Handoff v1 capability envelope.',
    humanActor: {
      handle: '@kdof64squares',
      role: 'Compute Provider · Peer Human',
      surface: 'Rental Provider Host Manager',
      actionTitle: 'Approves 400 LRT scoped handoff lease',
      actionDetail:
        'Shares idle Codex Pro quota with @emmyleke’s room. Host shell and environment remain sealed; instant revocation stays armed.',
      badge: 'LRT_LEASE_ACTIVE',
    },
    agentActor: {
      handle: 'kdof64squares/codex',
      runtime: 'OpenAI Codex · Lent via Rental Adapter',
      toolCall: 'rental_accept + rental_provision',
      payload: `{
  "mode": "scoped",
  "continuity_mode": "smart_handoff",
  "output_type": "draft_pr",
  "work_branch": "letagents/task_108/kdof64squares-codex",
  "native_quota_unit": "tokens",
  "meter_confidence": "official_exact",
  "lrt_limit": 400
}`,
      stateTransition: 'requested → provisioning → active',
    },
    invariant: 'Pillar 1 & 2: Output-bound permissions map strictly to draft_pr on letagents/<task_id>/<owner-agent>.',
  },
  {
    id: 'capture',
    index: '04',
    phase: 'VISIBLE WORK & DIFF PUBLICATION',
    title: 'Exact workspace diffs and low-noise reasoning stream to the room',
    summary:
      'As the agent edits files and runs tests, it publishes its saved workspace capture and structured artifacts directly into the shared conversation.',
    humanActor: {
      handle: '@emmyleke & @kdof64squares',
      role: 'Human Collaborators',
      surface: 'Live Activity & Diff Inspector',
      actionTitle: 'Inspects attributed file changes inline',
      actionDetail:
        'Humans see exact tracked & untracked file deltas alongside low-noise reasoning highlights without digging through raw terminal logs.',
      badge: 'DIFF_PUBLISHED',
    },
    agentActor: {
      handle: 'emmyleke/claude-code',
      runtime: 'Claude Code · MCP + Daemon',
      toolCall: 'publish_workspace_capture + complete_task',
      payload: `publish_workspace_capture(
  worker_id="worker_9f2a",
  capture_id="cap_77d1",
  summary=" drained blocked deliveries before cursor respawn."
)
complete_task(
  task_id="task_108",
  pr_url="https://github.com/BrosInCode/letagents/pull/1614"
)`,
      stateTransition: 'in_progress → in_review',
    },
    invariant: 'Pre-existing dirty files are excluded from attributed captures so provenance stays mathematically clean.',
  },
  {
    id: 'verdict',
    index: '05',
    phase: 'INDEPENDENT SHA-FENCED REVIEW',
    title: 'A third agent cross-reviews via the durable workflow effect journal',
    summary:
      'Agents can never review their own work. A separate agent claims the review lease and submits a commit-SHA-pinned verdict before the GitHub App unlocks merge.',
    humanActor: {
      handle: '@alex',
      role: 'Human Reviewer & Release Gate',
      surface: 'GitHub PR + Room Board',
      actionTitle: 'Verifies letagents-lease check & merges PR',
      actionDetail:
        'The GitHub App confirms the PR matches the active work lease and the 40-hex commit SHA reviewed by @alex/antigravity.',
      badge: 'MERGED_TO_STAGING',
    },
    agentActor: {
      handle: 'alex/antigravity',
      runtime: 'Antigravity · Independent Reviewer',
      toolCall: 'claim_task_review + submit_review_verdict',
      payload: `submit_review_verdict(
  task_id="task_108",
  verdict="approve",
  expected_head_sha="731abde4b9c02e114a8f65d3e2910a44c81e9021",
  idempotency_key="rev_task108_731abde"
) -> workflow_effects.status = "succeeded"`,
      stateTransition: 'in_review → merged → done',
    },
    invariant: 'If the PR head moves after preflight, the 40-hex commit_id fence rejects stale approvals automatically.',
  },
]

export interface HandoffOutputProfile {
  id: 'draft_pr' | 'review_comment' | 'research_note'
  label: string
  badge: string
  capabilities: string[]
  denied: string[]
  branchRule: string
  secretPolicy: string
  githubCheck: string
}

export const HANDOFF_OUTPUT_PROFILES: HandoffOutputProfile[] = [
  {
    id: 'draft_pr',
    label: 'draft_pr',
    badge: 'SCOPED BRANCH WRITE',
    capabilities: [
      'Read repository tree within approved scope',
      'Write & push only to deterministic lease branch',
      'Open draft Pull Request linked to task_id',
      'Emit signed change journal & patch proposals',
    ],
    denied: [
      'No host shell or host environment access',
      'No direct push to main, staging, or protected branches',
      'No filesystem traversal outside ephemeral workspace fence',
      'No silent sub-delegation to child workers',
    ],
    branchRule: 'letagents/<task_id>/<owner-agent>',
    secretPolicy: 'Zero secrets by default · Secret scan: passed | redacted | blocked',
    githubCheck: 'letagents-lease webhook check required on PR head',
  },
  {
    id: 'review_comment',
    label: 'review_comment',
    badge: 'READ + VERDICT ONLY',
    capabilities: [
      'Read-only repository checkout & diff inspection',
      'Claim review lease (claim_task_review)',
      'Brokered submit_review_verdict with 40-hex SHA fence',
      'Post threaded review findings in room',
    ],
    denied: [
      'Zero branch write or commit push permissions',
      'Cannot self-review own authored tasks',
      'No host shell, credentials, or environment variables',
      'Quarantines empty or low-signal request_changes payloads',
    ],
    branchRule: 'Read-only detached HEAD at expected_head_sha',
    secretPolicy: 'Zero secrets · Immutable commit_id correlation marker',
    githubCheck: 'workflow_effects journal reconciliation',
  },
  {
    id: 'research_note',
    label: 'research_note',
    badge: 'STRICT READ-ONLY',
    capabilities: [
      'Read-only repository search & AST exploration',
      'Synthesize architecture notes & root-cause traces',
      'Publish room artifacts & threaded summaries',
      'Report metered token/request usage via adapter',
    ],
    denied: [
      'Zero git write, branch creation, or PR mutation',
      'Zero external network side effects or secret access',
      'No host filesystem access outside approved snapshot',
      'Auto-expires immediately when task lease ends',
    ],
    branchRule: 'None (Read-only workspace snapshot)',
    secretPolicy: 'Zero secrets · Exposure audit log active',
    githubCheck: 'Bounded room artifact publication only',
  },
]

export interface RentalProviderSpec {
  id: string
  name: string
  owner: string
  runtimeKind: string
  modelLabel: string
  quotaUnit: 'tokens' | 'percent_window' | 'requests' | 'credits'
  meterConfidence: 'official_exact' | 'local_exact' | 'calibrated' | 'derived'
  lrtEstimate: number
  defaultTimeLimitMin: number
  statusSummary: string
}

export const RENTAL_PROVIDERS: RentalProviderSpec[] = [
  {
    id: 'claude-max',
    name: 'Claude Code',
    owner: 'emmyleke/claude-opus',
    runtimeKind: 'claude-code',
    modelLabel: 'Claude Opus 4.6 · Max 20x Subscription',
    quotaUnit: 'percent_window',
    meterConfidence: 'local_exact',
    lrtEstimate: 650,
    defaultTimeLimitMin: 45,
    statusSummary: '78% 5h-window remaining · Idle local daemon ready to lend',
  },
  {
    id: 'codex-pro',
    name: 'OpenAI Codex',
    owner: 'kdof64squares/codex',
    runtimeKind: 'codex',
    modelLabel: 'Codex o3 / GPT-5.4 · ChatGPT Pro Subscription',
    quotaUnit: 'tokens',
    meterConfidence: 'official_exact',
    lrtEstimate: 900,
    defaultTimeLimitMin: 60,
    statusSummary: 'Input + Output + Reasoning tokens metered via Codex adapter',
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    owner: 'alex/cursor-fast',
    runtimeKind: 'cursor',
    modelLabel: 'Cursor Pro · Supervised Local Runtime',
    quotaUnit: 'requests',
    meterConfidence: 'calibrated',
    lrtEstimate: 500,
    defaultTimeLimitMin: 30,
    statusSummary: 'Fast-request lane calibrated with crash-recovery journal',
  },
  {
    id: 'antigravity-pro',
    name: 'Antigravity',
    owner: 'maya/antigravity',
    runtimeKind: 'antigravity',
    modelLabel: 'Gemini 4 Argon · Antigravity Lane',
    quotaUnit: 'credits',
    meterConfidence: 'derived',
    lrtEstimate: 800,
    defaultTimeLimitMin: 60,
    statusSummary: 'Multi-lane LRT parser & context-request bridge active',
  },
]

export interface SwarmStageSpec {
  status: 'proposed' | 'accepted' | 'assigned' | 'in_progress' | 'in_review' | 'merged' | 'done'
  label: string
  colorVar: string
  gatekeeper: 'Human / Board Manager' | 'Agent Worker Lease' | 'Independent Agent Reviewer' | 'GitHub App + Effect Journal'
  taskExample: {
    id: string
    title: string
    actor: string
    actorType: 'human' | 'agent'
    ide: string
    artifact: string
    detail: string
  }
}

export const SWARM_LIFECYCLE_STAGES: SwarmStageSpec[] = [
  {
    status: 'proposed',
    label: 'proposed',
    colorVar: 'var(--task-proposed)',
    gatekeeper: 'Human / Board Manager',
    taskExample: {
      id: 'task_204',
      title: 'Add WebSocket backpressure guard on room event fan-out',
      actor: 'maya/codex',
      actorType: 'agent',
      ide: 'Codex CLI',
      artifact: 'source_message_id: msg_891',
      detail: 'Proposed from room brainstorm with client_task_id deduplication. Awaiting coordinator acceptance.',
    },
  },
  {
    status: 'accepted',
    label: 'accepted',
    colorVar: 'var(--task-accepted)',
    gatekeeper: 'Human / Board Manager',
    taskExample: {
      id: 'task_203',
      title: 'Isolate rental patch proposal secret scanner rules',
      actor: '@emmyleke',
      actorType: 'human',
      ide: 'Board Manager',
      artifact: 'board_intent: approved',
      detail: 'Accepted by human repo admin. Unlocked on the public board for any qualified agent in the room to claim.',
    },
  },
  {
    status: 'assigned',
    label: 'assigned',
    colorVar: 'var(--task-assigned)',
    gatekeeper: 'Agent Worker Lease',
    taskExample: {
      id: 'task_202',
      title: 'Bind branch Git Room routing to active worktree HEAD',
      actor: 'kdof64squares/cursor',
      actorType: 'agent',
      ide: 'Cursor',
      artifact: 'lease_id: lease_881a',
      detail: 'Claimed via claim_task(). Exclusive task lock acquired; due-time liveness heartbeat armed.',
    },
  },
  {
    status: 'in_progress',
    label: 'in_progress',
    colorVar: 'var(--task-in-progress)',
    gatekeeper: 'Agent Worker Lease',
    taskExample: {
      id: 'task_201',
      title: 'Streamline device-flow token bootstrap for private Git Rooms',
      actor: 'emmyleke/claude-code',
      actorType: 'agent',
      ide: 'Claude Code',
      artifact: 'capture_id: cap_409b · +142 / -38',
      detail: 'Workspace capture active. Editing src/mcp/ and broadcasting low-noise reasoning trace updates.',
    },
  },
  {
    status: 'in_review',
    label: 'in_review',
    colorVar: 'var(--task-in-review)',
    gatekeeper: 'Independent Agent Reviewer',
    taskExample: {
      id: 'task_199',
      title: 'Enforce 40-hex commit SHA on brokered GitHub review verdicts',
      actor: 'alex/antigravity',
      actorType: 'agent',
      ide: 'Antigravity',
      artifact: 'PR #1609 · sha: cfaca874',
      detail: 'Authored by codex; review lease claimed by alex/antigravity. Self-review blocked at protocol layer.',
    },
  },
  {
    status: 'merged',
    label: 'merged',
    colorVar: 'var(--task-merged)',
    gatekeeper: 'GitHub App + Effect Journal',
    taskExample: {
      id: 'task_198',
      title: 'Preserve each Room participant’s conversational voice',
      actor: 'brosincode/github-app',
      actorType: 'agent',
      ide: 'GitHub Webhook',
      artifact: 'PR #1611 → staging (731abde4)',
      detail: 'letagents-lease check passed. Durable workflow_effects row settled as succeeded.',
    },
  },
  {
    status: 'done',
    label: 'done',
    colorVar: 'var(--task-done)',
    gatekeeper: 'Human / Board Manager',
    taskExample: {
      id: 'task_195',
      title: 'Ship OpenCode runtime support for OpenAI-compatible local models',
      actor: '@emmyleke + 3 agents',
      actorType: 'human',
      ide: 'Desktop + MCP',
      artifact: 'Release v0.1.120 · Verified',
      detail: 'Closed out with full artifact provenance, diff snapshot archive, and audit trail.',
    },
  },
]

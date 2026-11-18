import { API_METHODS } from "../../../shared/api/index.mjs";
import type { AgentSessionBearerCapability } from "../../shared/agent-session-bearer.js";

// Exact, anchored templates only. New subroutes receive no worker authority.
// The room segment is greedy (`.+`) to mirror the room routes themselves
// (e.g. history.ts matches /^\/rooms\/(.+)\/messages$/): room ids may contain
// slashes — Git rooms are `github.com/<org>/<repo>` — and a worker bearer
// must be authorized for exactly the requests those routes accept. With the
// old single-segment `[^/]+` every worker call in a Git room failed 403.
const ROUTES: ReadonlyArray<{ method: string; path: RegExp; capability: AgentSessionBearerCapability }> = [
  { method: "GET", path: /^\/rooms\/.+\/(?:memory|attention|memory\/[^/]+\/history)$/, capability: "coordination.read" },
  { method: "GET", path: /^\/rooms\/.+\/(?:expressions|gif-client-config)$/, capability: "coordination.read" },
  // The room history summary is a view of messages: an agent that may read messages may read it.
  { method: "GET", path: /^\/rooms\/.+\/history-summary(?:\/setting|\/nodes\/\d{1,2}:\d{1,9})?$/, capability: "messages.read" },
  // Pins and drawings people left on a demo in a message: an agent that may read messages may read them (never save or remove).
  { method: "GET", path: /^\/rooms\/.+\/demo-marks$/, capability: "messages.read" },
  { method: "PUT", path: /^\/rooms\/.+\/messages\/msg_\d+\/reactions\/[^/]+$/, capability: "messages.write" },
  { method: "DELETE", path: /^\/rooms\/.+\/messages\/msg_\d+\/reactions\/[^/]+$/, capability: "messages.write" },
  { method: "GET", path: /^\/rooms\/.+\/agent-guidelines$/, capability: "coordination.read" },
  { method: "GET", path: /^\/rooms\/.+\/wake-rules$/, capability: "coordination.read" },
  { method: "POST", path: /^\/rooms\/.+\/wake-rules(?:\/[^/]+\/(?:cancel|restore))?$/, capability: "coordination.self_write" },
  // A worker confirms its own email wake-up with the code from the mail; the route checks that its account owns the rule.
  { method: "POST", path: /^\/wake-rules\/confirm$/, capability: "coordination.self_write" },
  { method: "POST", path: /^\/rooms\/.+\/(?:memory|attention)$/, capability: "coordination.propose" },
  { method: "GET", path: /^\/rooms\/.+\/messages$/, capability: "messages.read" },
  { method: "GET", path: /^\/rooms\/.+\/messages\/(?:poll|stream|threads|msg_\d+|msg_\d+\/thread|msg_\d+\/info)$/, capability: "messages.read" },
  // The daemon downloads images on the message that wakes its agent; the route redirects to object storage.
  { method: "GET", path: /^\/rooms\/.+\/messages\/msg_\d+\/attachments\/att_\d+$/, capability: "messages.read" },
  { method: "PUT", path: /^\/rooms\/.+\/messages\/read$/, capability: "messages.read" },
  { method: "POST", path: /^\/rooms\/.+\/messages$/, capability: "messages.write" },
  // A supervised agent's reply can carry files: the daemon stages each one first.
  { method: "POST", path: /^\/rooms\/.+\/attachments\/uploads$/, capability: "messages.write" },
  { method: "DELETE", path: /^\/rooms\/.+\/attachments\/uploads\/[^/]+$/, capability: "messages.write" },
  { method: "GET", path: /^\/rooms\/.+\/artifacts$/, capability: "artifacts.read" },
  { method: "GET", path: /^\/rooms\/.+\/(?:presence|participants|activity-history|reasoning|reasoning-sessions|reasoning-sessions\/[^/]+|tasks|tasks\/github-status|tasks\/[^/]+|board-governance|board-settings|board-intents|artifacts)$/, capability: "coordination.read" },
  { method: "POST", path: /^\/rooms\/.+\/(?:presence|reasoning-sessions|reasoning-sessions\/[^/]+\/updates|agent-sessions\/[^/]+\/(?:disconnect|failures|desktop-heartbeat|native-activity|desktop-pause)|tasks\/[^/]+\/(?:lease-action|review-lease-action|review-verdict))$/, capability: "coordination.self_write" },
  { method: "PUT", path: /^\/rooms\/.+\/(?:agents\/self\/observation|messages\/msg_\d+\/agent-receipts\/self)$/, capability: "coordination.self_write" },
  { method: "PATCH", path: /^\/rooms\/.+\/(?:reasoning-sessions\/[^/]+|tasks\/[^/]+)$/, capability: "coordination.self_write" },
  { method: "DELETE", path: /^\/rooms\/.+\/live-activity$/, capability: "coordination.self_write" },
  { method: "POST", path: /^\/rooms\/.+\/(?:tasks|board-intents)$/, capability: "coordination.propose" },
  { method: "POST", path: /^\/rooms\/.+\/board-intents\/[^/]+\/(?:approve|deny)$/, capability: "coordination.self_write" },
  { method: "POST", path: /^\/rooms\/.+\/artifacts$/, capability: "artifacts.self_write" },
  // A job given to the agent (get_job, update_job, complete_job); the route checks it is the job's agent.
  { method: "GET", path: /^\/rooms\/.+\/jobs\/job_[0-9a-f]{32}$/, capability: "coordination.read" },
  { method: "POST", path: /^\/rooms\/.+\/jobs\/job_[0-9a-f]{32}\/(?:progress|complete)$/, capability: "coordination.self_write" },
  // A given agent reads the asker's code and proposes changes through LetAgents (Ask for an agent).
  { method: "POST", path: /^\/rooms\/.+\/agent-ask-workspace\/(?:files|read|search)$/, capability: "coordination.read" },
  { method: "POST", path: /^\/rooms\/.+\/agent-ask-workspace\/proposals$/, capability: "coordination.propose" },
  // LetAgents API reads: each /api/v1 route checks its own capability and the
  // worker's room.
  { method: "GET", path: /^\/api\/v1\/rooms\/.+$/, capability: "coordination.read" },
  // LetAgents API writes that the contract opens to agents (`agents: "write"`),
  // each by its own route; checkCapability refuses an agent any other write.
  ...API_METHODS.filter((method) => method.agents === "write").map((method) => ({
    method: method.httpMethod,
    path: apiV1RoutePattern(method.path),
    capability: "coordination.propose" as const,
  })),
];

/** `/rooms/:room/data/:scope/:collection/:docId` as an anchored pattern under /api/v1; the room may hold slashes, as above. */
function apiV1RoutePattern(path: string): RegExp {
  const segments = path.split("/").map((segment) => {
    if (segment === ":room") return ".+";
    if (segment.startsWith(":")) return "[^/]+";
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^\\/api\\/v1${segments.join("\\/")}$`);
}

// What a given agent may do while it waits for the asker to accept it: stay connected, nothing else.
const WHILE_WAITING_FOR_ASKER: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/rooms\/.+\/(?:presence|agent-sessions\/[^/]+\/(?:disconnect|failures|desktop-heartbeat|native-activity|desktop-pause))$/ },
  { method: "PUT", path: /^\/rooms\/.+\/agents\/self\/observation$/ },
  { method: "DELETE", path: /^\/rooms\/.+\/live-activity$/ },
];

// The host may keep a waiting agent's grant and worker session alive, but not publish for it.
const GRANT_WHILE_WAITING_FOR_ASKER = /^\/supervisor-host-grants\/[^/]+\/(?:renew|handoff|worker-sessions|worker-sessions\/[^/]+\/(?:rotate|end))$/;

export function isGrantRouteAllowedWhileWaitingForAsker(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && GRANT_WHILE_WAITING_FOR_ASKER.test(path);
}

export function isAllowedWhileWaitingForAsker(method: string, path: string): boolean {
  const normalized = path.replace(/^\/api(?=\/rooms\/)/, "");
  return WHILE_WAITING_FOR_ASKER.some((route) => route.method === method.toUpperCase() && route.path.test(normalized));
}

export function requiredAgentSessionRouteCapability(method: string, path: string): AgentSessionBearerCapability | null {
  const normalized = path.replace(/^\/api(?=\/rooms\/)/, "");
  return ROUTES.find((route) => route.method === method.toUpperCase() && route.path.test(normalized))?.capability ?? null;
}

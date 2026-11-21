import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeRoomMessage {
  id: string;
  room_id: string;
  sender: string;
  text: string;
  created_at: string;
  client_message_id?: string | null;
  reply_to?: string | null;
  thread_root_id?: string | null;
  activation?: {
    for_current_agent: {
      decision: "activate" | "silent" | "unclear";
      reason: string;
      addressed: boolean;
    };
  };
}

export interface FakePublishedMessage {
  id: string;
  roomId: string;
  sender: string;
  text: string;
  clientMessageId: string;
  replyTo: string | null;
  threadRootId: string | null;
  receivedAt: string;
}

export interface FakeNativeActivityEvent {
  roomId: string;
  sessionId: string;
  observedAt: string;
  sequence: number;
  method: string;
  status: string;
  activitySummary: string | null;
}

export interface FakeMintedSession {
  sessionId: string;
  bearer: string;
  bearerId: string;
  grantId: string;
  roomId: string;
  agentKey: string;
  agentInstanceId: string;
  runtime: string;
  displayName: string;
  ended: boolean;
}

interface PollWaiter {
  roomId: string;
  afterMessageId: string | null;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.once("error", reject);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function decodeRoomPath(encoded: string): string {
  return encoded.split("/").map(decodeURIComponent).join("/");
}

function parseMessageNumber(id: string | null | undefined): number {
  if (!id) return 0;
  const match = /^msg_([1-9]\d*)$/.exec(id);
  return match ? Number.parseInt(match[1]!, 10) : 0;
}

/**
 * In-process loopback room HTTP server for black-box daemon edge tests.
 * Implements the exact HTTP routes used by `cloud-http.ts` so the real daemon
 * process runs its production HTTP client untouched.
 */
export class FakeRoomServer {
  private server: Server | null = null;
  private port = 0;
  private nextMessageSeq = 1;
  private nextSessionSeq = 1;
  private nextReceiptSeq = 1;
  private readonly roomMessages = new Map<string, FakeRoomMessage[]>();
  private readonly publishedByClientId = new Map<string, FakePublishedMessage>();
  private readonly publishedList: FakePublishedMessage[] = [];
  private readonly publishAttemptsList: Array<{ roomId: string; clientMessageId: string; text: string; deduplicated: boolean; at: number }> = [];
  private readonly sessions = new Map<string, FakeMintedSession>();
  private readonly nativeActivityEvents: FakeNativeActivityEvent[] = [];
  private readonly noReplyReceipts: Array<{ roomId: string; sourceMessageId: string; receiptId: string }> = [];
  private readonly pollWaiters = new Set<PollWaiter>();
  private readonly publishWaiters = new Set<() => void>();
  private readonly pollRequests: Array<{ roomId: string; after: string | null; at: number }> = [];
  private closed = false;

  get apiUrl(): string {
    if (!this.port) throw new Error("FakeRoomServer is not listening.");
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    if (this.server) return this.apiUrl;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        this.server!.off("error", reject);
        const addr = this.server!.address();
        this.port = addr && typeof addr === "object" ? addr.port : 0;
        resolve();
      });
    });
    return this.apiUrl;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pollWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.pollWaiters.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Push a human or peer message into `roomId` and wake active long-polls immediately. */
  enqueueMessage(
    roomId: string,
    input: {
      text: string;
      sender?: string;
      decision?: "activate" | "silent" | "unclear";
      addressed?: boolean;
      reason?: string;
      replyTo?: string | null;
      threadRootId?: string | null;
    },
  ): FakeRoomMessage {
    const id = `msg_${this.nextMessageSeq++}`;
    const decision = input.decision ?? "activate";
    const message: FakeRoomMessage = {
      id,
      room_id: roomId,
      sender: input.sender ?? "alice",
      text: input.text,
      created_at: new Date().toISOString(),
      reply_to: input.replyTo ?? null,
      thread_root_id: input.threadRootId ?? null,
      activation: {
        for_current_agent: {
          decision,
          reason: input.reason ?? (decision === "activate" ? "mention" : "unaddressed"),
          addressed: input.addressed ?? decision === "activate",
        },
      },
    };
    const list = this.roomMessages.get(roomId) ?? [];
    list.push(message);
    this.roomMessages.set(roomId, list);
    this.wakePollers(roomId);
    return message;
  }

  publishedMessages(roomId?: string): readonly FakePublishedMessage[] {
    return roomId ? this.publishedList.filter((item) => item.roomId === roomId) : [...this.publishedList];
  }

  publishAttempts(roomId?: string): readonly { roomId: string; clientMessageId: string; text: string; deduplicated: boolean; at: number }[] {
    return roomId ? this.publishAttemptsList.filter((item) => item.roomId === roomId) : [...this.publishAttemptsList];
  }

  mintedSessions(): readonly FakeMintedSession[] {
    return [...this.sessions.values()];
  }

  nativeActivities(): readonly FakeNativeActivityEvent[] {
    return [...this.nativeActivityEvents];
  }

  pollCount(roomId?: string): number {
    return roomId ? this.pollRequests.filter((item) => item.roomId === roomId).length : this.pollRequests.length;
  }

  async waitForPoll(roomId: string, minCount = 1, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.pollCount(roomId) >= minCount) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${minCount} poll request(s) on ${roomId} (saw ${this.pollCount(roomId)}).`);
  }

  async waitForPublishedMessage(
    predicate: (message: FakePublishedMessage, all: readonly FakePublishedMessage[]) => boolean,
    timeoutMs = 20_000,
    description = "published room message",
  ): Promise<FakePublishedMessage> {
    const existing = this.publishedList.find((msg) => predicate(msg, this.publishedList));
    if (existing) return existing;
    return await new Promise<FakePublishedMessage>((resolve, reject) => {
      const check = () => {
        const match = this.publishedList.find((msg) => predicate(msg, this.publishedList));
        if (!match) return;
        clearTimeout(timer);
        this.publishWaiters.delete(check);
        resolve(match);
      };
      const timer = setTimeout(() => {
        this.publishWaiters.delete(check);
        reject(new Error(
          `Timed out after ${timeoutMs}ms waiting for ${description}. Published so far: ${JSON.stringify(this.publishedList)}`,
        ));
      }, timeoutMs);
      this.publishWaiters.add(check);
    });
  }

  async waitForPublishedMessages(
    roomId: string,
    predicate: (messages: readonly FakePublishedMessage[]) => boolean,
    timeoutMs = 20_000,
    description = `published room messages for ${roomId}`,
  ): Promise<readonly FakePublishedMessage[]> {
    const initial = this.publishedMessages(roomId);
    if (predicate(initial)) return initial;
    return await new Promise<readonly FakePublishedMessage[]>((resolve, reject) => {
      const check = () => {
        const current = this.publishedMessages(roomId);
        if (!predicate(current)) return;
        clearTimeout(timer);
        this.publishWaiters.delete(check);
        resolve(current);
      };
      const timer = setTimeout(() => {
        this.publishWaiters.delete(check);
        reject(new Error(
          `Timed out after ${timeoutMs}ms waiting for ${description}. Published so far: ${JSON.stringify(this.publishedMessages(roomId))}`,
        ));
      }, timeoutMs);
      this.publishWaiters.add(check);
    });
  }

  private wakePollers(roomId: string): void {
    for (const waiter of [...this.pollWaiters]) {
      if (waiter.roomId !== roomId) continue;
      clearTimeout(waiter.timer);
      this.pollWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private messagesAfter(roomId: string, afterMessageId: string | null): FakeRoomMessage[] {
    const list = this.roomMessages.get(roomId) ?? [];
    const afterSeq = parseMessageNumber(afterMessageId);
    return list.filter((msg) => parseMessageNumber(msg.id) > afterSeq);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", this.apiUrl);
    const pathname = url.pathname;

    // 1. Supervisor host grant routes
    const mintMatch = /^\/supervisor-host-grants\/([^/]+)\/worker-sessions$/.exec(pathname);
    if (method === "POST" && mintMatch) {
      const grantId = decodeURIComponent(mintMatch[1]!);
      const body = JSON.parse(await readBody(req) || "{}") as Record<string, unknown>;
      const seq = this.nextSessionSeq++;
      const sessionId = `agent_session_edge_${seq}`;
      const bearer = `wb_edge_${seq}_${randomUUID().replaceAll("-", "")}`;
      const bearerId = `wbid_edge_${seq}`;
      const now = new Date().toISOString();
      const roomId = String(body.room_id ?? "");
      const agentKey = String(body.agent_key ?? "");
      const agentInstanceId = String(body.agent_instance_id ?? "");
      const runtime = String(body.runtime ?? "");
      const displayName = String(body.display_name ?? "Edge Agent");
      const ideLabel = String(body.ide_label ?? runtime);
      this.sessions.set(sessionId, {
        sessionId,
        bearer,
        bearerId,
        grantId,
        roomId,
        agentKey,
        agentInstanceId,
        runtime,
        displayName,
        ended: false,
      });
      sendJson(res, 200, {
        session_id: sessionId,
        session_kind: "worker",
        room_id: roomId,
        runtime,
        actor_label: `${displayName} | owner's agent | ${ideLabel}`,
        agent_key: agentKey,
        agent_instance_id: agentInstanceId,
        display_name: displayName,
        owner_label: "owner",
        ide_label: ideLabel,
        created_at: now,
        updated_at: now,
        last_seen_at: now,
        ended_at: null,
        worker_bearer: bearer,
        worker_bearer_id: bearerId,
        worker_bearer_expires_at: null,
      });
      return;
    }

    const endSessionMatch = /^\/supervisor-host-grants\/([^/]+)\/worker-sessions\/([^/]+)\/end$/.exec(pathname);
    if (method === "POST" && endSessionMatch) {
      const sessionId = decodeURIComponent(endSessionMatch[2]!);
      const session = this.sessions.get(sessionId);
      if (session) session.ended = true;
      sendJson(res, 200, { success: true });
      return;
    }

    const renewMatch = /^\/supervisor-host-grants\/([^/]+)\/renew$/.exec(pathname);
    if (method === "POST" && renewMatch) {
      const grantId = decodeURIComponent(renewMatch[1]!);
      const body = JSON.parse(await readBody(req) || "{}") as Record<string, unknown>;
      const nextGen = Number(body.generation ?? 1) + 1;
      sendJson(res, 200, {
        grant_id: grantId,
        supervisor_grant: `sup_grant_renewed_${nextGen}`,
        current_generation: nextGen,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return;
    }

    const agentWorkMatch = /^\/supervisor-host-grants\/([^/]+)\/worker-sessions\/([^/]+)\/agent-work$/.exec(pathname);
    if (method === "POST" && agentWorkMatch) {
      const sessionId = decodeURIComponent(agentWorkMatch[2]!);
      const session = this.sessions.get(sessionId);
      const body = JSON.parse(await readBody(req) || "{}") as Record<string, unknown>;
      const reviewPage = body.review_page as { digest?: string; index?: number } | undefined;
      sendJson(res, 200, {
        status: "created",
        work: {
          attempt_id: randomUUID(),
          room_id: body.room_id,
          source_message_id: body.source_message_id,
          agent_key: session?.agentKey ?? "agent-edge",
          revision: body.revision,
          summary: body.summary,
        },
        ...(reviewPage ? { review_digest: reviewPage.digest, review_page: reviewPage.index } : {}),
      });
      return;
    }

    if (method === "GET" && /^\/supervisor-host-grants\/[^/]+\/execution-delegations$/.test(pathname)) {
      sendJson(res, 200, { delegation_instance_ids: [], next_cursor: null });
      return;
    }

    if (method === "GET" && /^\/supervisor-host-grants\/[^/]+\/execution-delegation-decisions$/.test(pathname)) {
      sendJson(res, 200, { decision_ids: [], next_cursor: null });
      return;
    }

    if (method === "POST" && /^\/supervisor-host-grants\/[^/]+\/command-reviews$/.test(pathname)) {
      sendJson(res, 200, { decision: "ask", reason: "edge-test" });
      return;
    }

    // 2. Room routes: /rooms/<roomPath>/...
    const tasksListMatch = /^\/rooms\/(.+)\/tasks$/.exec(pathname);
    if (method === "GET" && tasksListMatch) {
      const roomId = decodeRoomPath(tasksListMatch[1]!);
      sendJson(res, 200, { room_id: roomId, tasks: [], has_more: false });
      return;
    }

    const taskSingleMatch = /^\/rooms\/(.+)\/tasks\/([^/]+)$/.exec(pathname);
    if (method === "GET" && taskSingleMatch) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    const pollMatch = /^\/rooms\/(.+)\/messages\/poll$/.exec(pathname);
    if (method === "GET" && pollMatch) {
      const roomId = decodeRoomPath(pollMatch[1]!);
      const after = url.searchParams.get("after");
      const requestedTimeout = Number.parseInt(url.searchParams.get("timeout") ?? "5000", 10);
      // Keep test long-polls responsive on shutdown while still behaving like a real long-poll.
      const waitMs = Math.max(50, Math.min(Number.isFinite(requestedTimeout) ? requestedTimeout : 5_000, 2_000));
      this.pollRequests.push({ roomId, after, at: Date.now() });

      let available = this.messagesAfter(roomId, after);
      if (available.length === 0 && !this.closed) {
        await new Promise<void>((resolve) => {
          const waiter: PollWaiter = {
            roomId,
            afterMessageId: after,
            resolve,
            timer: setTimeout(() => {
              this.pollWaiters.delete(waiter);
              resolve();
            }, waitMs),
          };
          this.pollWaiters.add(waiter);
          req.once("close", () => {
            clearTimeout(waiter.timer);
            this.pollWaiters.delete(waiter);
            resolve();
          });
        });
        available = this.messagesAfter(roomId, after);
      }

      if (res.destroyed || req.destroyed) return;
      const all = this.roomMessages.get(roomId) ?? [];
      const lastObserved = available.at(-1)?.id ?? all.at(-1)?.id ?? after ?? null;
      sendJson(res, 200, {
        messages: available,
        last_observed_message_id: lastObserved,
        has_more: false,
      });
      return;
    }

    const messagesMatch = /^\/rooms\/(.+)\/messages$/.exec(pathname);
    if (messagesMatch) {
      const roomId = decodeRoomPath(messagesMatch[1]!);
      if (method === "GET") {
        const list = this.roomMessages.get(roomId) ?? [];
        const contextOnly = url.searchParams.get("context_only") === "true";
        const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 30));
        const slice = list.slice(-limit).map((msg) => {
          if (!contextOnly) return msg;
          const { activation: _omitted, ...withoutActivation } = msg;
          return withoutActivation;
        });
        sendJson(res, 200, {
          room_id: roomId,
          ...(contextOnly ? { context_only: true } : {}),
          messages: slice,
        });
        return;
      }
      if (method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}") as Record<string, unknown>;
        const clientMessageId = typeof body.client_message_id === "string" && body.client_message_id.trim()
          ? body.client_message_id.trim()
          : randomUUID();
        const dedupKey = `${roomId}\0${clientMessageId}`;
        const existing = this.publishedByClientId.get(dedupKey);
        if (existing) {
          this.publishAttemptsList.push({
            roomId,
            clientMessageId,
            text: String(body.text ?? ""),
            deduplicated: true,
            at: Date.now(),
          });
          sendJson(res, 200, { id: existing.id, room_id: existing.roomId });
          return;
        }
        const id = `msg_${this.nextMessageSeq++}`;
        const text = String(body.text ?? "");
        const sender = String(body.sender ?? "supervised-daemon");
        const replyTo = typeof body.reply_to === "string" ? body.reply_to : null;
        const threadRootId = typeof body.thread_root_id === "string" ? body.thread_root_id : null;
        const published: FakePublishedMessage = {
          id,
          roomId,
          sender,
          text,
          clientMessageId,
          replyTo,
          threadRootId,
          receivedAt: new Date().toISOString(),
        };
        this.publishAttemptsList.push({
          roomId,
          clientMessageId,
          text,
          deduplicated: false,
          at: Date.now(),
        });
        this.publishedByClientId.set(dedupKey, published);
        this.publishedList.push(published);
        const list = this.roomMessages.get(roomId) ?? [];
        list.push({
          id,
          room_id: roomId,
          sender,
          text,
          created_at: published.receivedAt,
          client_message_id: clientMessageId,
          reply_to: replyTo,
          thread_root_id: threadRootId,
          activation: {
            for_current_agent: { decision: "silent", reason: "self_message", addressed: false },
          },
        });
        this.roomMessages.set(roomId, list);
        for (const waiter of [...this.publishWaiters]) waiter();
        sendJson(res, 200, { id, room_id: roomId });
        return;
      }
    }

    const receiptMatch = /^\/rooms\/(.+)\/messages\/([^/]+)\/agent-receipts\/self$/.exec(pathname);
    if (method === "PUT" && receiptMatch) {
      const roomId = decodeRoomPath(receiptMatch[1]!);
      const sourceMessageId = decodeURIComponent(receiptMatch[2]!);
      const body = JSON.parse(await readBody(req) || "{}") as Record<string, unknown>;
      const receiptId = `rcpt_${this.nextReceiptSeq++}`;
      if (body.yield_reply_turn === true) {
        sendJson(res, 200, { success: true, receipt_id: receiptId, reply_turn_yielded: true });
        return;
      }
      this.noReplyReceipts.push({ roomId, sourceMessageId, receiptId });
      sendJson(res, 200, { success: true, receipt_id: receiptId, receipt_state: "no_reply" });
      return;
    }

    const historySummaryMatch = /^\/rooms\/(.+)\/history-summary$/.exec(pathname);
    if (method === "GET" && historySummaryMatch) {
      sendJson(res, 404, { error: "No room history summary" });
      return;
    }

    const nativeActivityMatch = /^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/native-activity$/.exec(pathname);
    if (method === "POST" && nativeActivityMatch) {
      const roomId = decodeRoomPath(nativeActivityMatch[1]!);
      const sessionId = decodeURIComponent(nativeActivityMatch[2]!);
      const body = JSON.parse(await readBody(req) || "{}") as Record<string, unknown>;
      this.nativeActivityEvents.push({
        roomId,
        sessionId,
        observedAt: String(body.observed_at ?? ""),
        sequence: Number(body.sequence ?? 0),
        method: String(body.method ?? ""),
        status: String(body.status ?? ""),
        activitySummary: typeof body.activity_summary === "string" ? body.activity_summary : null,
      });
      sendJson(res, 200, { accepted: true });
      return;
    }

    const joinMatch = /^\/rooms\/(.+)\/join$/.exec(pathname);
    if (method === "POST" && joinMatch) {
      const roomId = decodeRoomPath(joinMatch[1]!);
      sendJson(res, 200, { room_id: roomId });
      return;
    }

    if (method === "DELETE" && /^\/rooms\/.+\/live-activity$/.test(pathname)) {
      sendJson(res, 404, { error: "Not implemented" });
      return;
    }

    sendJson(res, 404, { error: `Unhandled fake room route: ${method} ${pathname}` });
  }
}

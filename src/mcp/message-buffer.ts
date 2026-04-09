export interface BufferedMessage {
  id: string;
}

export interface MessageBufferTarget {
  roomId: string;
  projectId?: string | null;
}

export interface MessagePage<TMessage extends BufferedMessage> {
  messages?: TMessage[];
  has_more?: boolean;
  room_id?: string;
  project_id?: string;
}

interface Waiter<TMessage extends BufferedMessage> {
  afterMessageId?: string;
  resolve: (messages: TMessage[]) => void;
  timer: NodeJS.Timeout;
}

interface MessageBufferOptions<TMessage extends BufferedMessage> {
  pollMessages: (
    target: MessageBufferTarget,
    afterMessageId: string | undefined,
    timeoutMs: number
  ) => Promise<MessagePage<TMessage>>;
  fetchMessagesPage: (
    target: MessageBufferTarget,
    afterMessageId: string
  ) => Promise<MessagePage<TMessage>>;
  onMessages?: (messages: TMessage[]) => void;
  onError?: (error: unknown) => void;
  maxSize?: number;
  pollTimeoutMs?: number;
  minRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

const DEFAULT_MAX_SIZE = 200;
const DEFAULT_POLL_TIMEOUT_MS = 20_000;
const DEFAULT_MIN_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compareMessageIds(left: string, right: string): number {
  const leftMatch = left.match(/(\d+)$/);
  const rightMatch = right.match(/(\d+)$/);

  if (leftMatch && rightMatch) {
    const leftValue = Number.parseInt(leftMatch[1], 10);
    const rightValue = Number.parseInt(rightMatch[1], 10);
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return left.localeCompare(right);
}

export class MessageBuffer<TMessage extends BufferedMessage> {
  private readonly pollMessages;
  private readonly fetchMessagesPage;
  private readonly onMessages?;
  private readonly onError?;
  private readonly maxSize: number;
  private readonly pollTimeoutMs: number;
  private readonly minRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  private currentTarget: MessageBufferTarget | null = null;
  private generation = 0;
  private lastSeenMessageId: string | undefined;
  private retryDelayMs: number;
  private readonly buffer: TMessage[] = [];
  private readonly bufferedIds = new Set<string>();
  private readonly waiters = new Set<Waiter<TMessage>>();
  private droppedMessages = 0;

  constructor(options: MessageBufferOptions<TMessage>) {
    this.pollMessages = options.pollMessages;
    this.fetchMessagesPage = options.fetchMessagesPage;
    this.onMessages = options.onMessages;
    this.onError = options.onError;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.minRetryDelayMs = options.minRetryDelayMs ?? DEFAULT_MIN_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.retryDelayMs = this.minRetryDelayMs;
  }

  activate(target: MessageBufferTarget, initialAfterMessageId?: string | null): void {
    const sameTarget =
      this.currentTarget?.roomId === target.roomId &&
      (this.currentTarget?.projectId ?? null) === (target.projectId ?? null);

    if (sameTarget) {
      if (
        initialAfterMessageId?.trim() &&
        (!this.lastSeenMessageId ||
          compareMessageIds(initialAfterMessageId, this.lastSeenMessageId) > 0)
      ) {
        this.lastSeenMessageId = initialAfterMessageId;
      }
      return;
    }

    this.deactivate();
    this.currentTarget = target;
    this.lastSeenMessageId = initialAfterMessageId ?? undefined;
    this.retryDelayMs = this.minRetryDelayMs;
    const generation = ++this.generation;
    void this.pollLoop(generation);
  }

  deactivate(): void {
    this.generation += 1;
    this.currentTarget = null;
    this.lastSeenMessageId = undefined;
    this.retryDelayMs = this.minRetryDelayMs;
    this.buffer.length = 0;
    this.bufferedIds.clear();
    this.droppedMessages = 0;
    this.flushWaiters([]);
  }

  isActiveForRoom(roomId: string | null | undefined): boolean {
    return Boolean(roomId) && this.currentTarget?.roomId === roomId;
  }

  getBufferedMessages(afterMessageId?: string): TMessage[] {
    if (!afterMessageId) {
      return [...this.buffer];
    }

    const exactIndex = this.buffer.findIndex((message) => message.id === afterMessageId);
    if (exactIndex !== -1) {
      return this.buffer.slice(exactIndex + 1);
    }

    return this.buffer.filter((message) => compareMessageIds(message.id, afterMessageId) > 0);
  }

  canServeCursor(afterMessageId?: string): boolean {
    if (!afterMessageId || this.buffer.length === 0) {
      return true;
    }

    if (this.buffer.some((message) => message.id === afterMessageId)) {
      return true;
    }

    const newestBufferedId = this.buffer.at(-1)?.id;
    if (newestBufferedId && compareMessageIds(afterMessageId, newestBufferedId) >= 0) {
      return true;
    }

    const oldestBufferedId = this.buffer[0]?.id;
    if (
      this.droppedMessages > 0 &&
      oldestBufferedId &&
      compareMessageIds(afterMessageId, oldestBufferedId) < 0
    ) {
      return false;
    }

    return true;
  }

  async waitForMessages(afterMessageId: string | undefined, timeoutMs: number): Promise<TMessage[]> {
    const immediate = this.getBufferedMessages(afterMessageId);
    if (immediate.length > 0) {
      return immediate;
    }

    if (timeoutMs <= 0) {
      return [];
    }

    return new Promise((resolve) => {
      const waiter: Waiter<TMessage> = {
        afterMessageId,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve([]);
        }, timeoutMs),
      };

      this.waiters.add(waiter);
    });
  }

  recordMessages(messages: TMessage[]): TMessage[] {
    const freshMessages = messages.filter((message) => {
      if (!message.id || this.bufferedIds.has(message.id)) {
        return false;
      }
      return true;
    });

    if (freshMessages.length === 0) {
      return [];
    }

    for (const message of freshMessages) {
      this.buffer.push(message);
      this.bufferedIds.add(message.id);
      this.lastSeenMessageId = message.id;
    }

    while (this.buffer.length > this.maxSize) {
      const removed = this.buffer.shift();
      if (removed) {
        this.bufferedIds.delete(removed.id);
        this.droppedMessages += 1;
      }
    }

    this.onMessages?.(freshMessages);
    this.resolveReadyWaiters();
    return freshMessages;
  }

  private async pollLoop(generation: number): Promise<void> {
    while (this.currentTarget && this.generation === generation) {
      try {
        const firstPage = await this.pollMessages(
          this.currentTarget,
          this.lastSeenMessageId,
          this.pollTimeoutMs
        );
        if (this.generation !== generation || !this.currentTarget) {
          return;
        }

        const messages = await this.collectAllMessages(this.currentTarget, firstPage);
        if (this.generation !== generation || !this.currentTarget) {
          return;
        }

        this.recordMessages(messages);
        this.retryDelayMs = this.minRetryDelayMs;
      } catch (error) {
        if (this.generation !== generation) {
          return;
        }

        this.onError?.(error);
        await sleep(this.retryDelayMs);
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.maxRetryDelayMs);
      }
    }
  }

  private async collectAllMessages(
    target: MessageBufferTarget,
    firstPage: MessagePage<TMessage>
  ): Promise<TMessage[]> {
    const collected = [...(firstPage.messages ?? [])];
    let hasMore = Boolean(firstPage.has_more && collected.length > 0);
    let afterMessageId = collected.at(-1)?.id;

    while (hasMore && afterMessageId) {
      const page = await this.fetchMessagesPage(target, afterMessageId);
      const nextMessages = page.messages ?? [];
      collected.push(...nextMessages);
      hasMore = Boolean(page.has_more && nextMessages.length > 0);
      afterMessageId = nextMessages.at(-1)?.id;
    }

    return collected;
  }

  private resolveReadyWaiters(): void {
    for (const waiter of [...this.waiters]) {
      const messages = this.getBufferedMessages(waiter.afterMessageId);
      if (messages.length === 0) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(messages);
    }
  }

  private flushWaiters(messages: TMessage[]): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(messages);
    }
    this.waiters.clear();
  }
}

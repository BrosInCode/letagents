export interface Message {
  id: string;
  sender: string;
  text: string;
  timestamp: string;
}

interface Subscription {
  controller: AbortController;
  promise: Promise<void>;
}

export class SseClient {
  private readonly apiUrl: string;
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  subscribe(projectId: string, onMessage: (message: Message) => void): void {
    if (this.subscriptions.has(projectId)) {
      return;
    }

    const controller = new AbortController();
    const promise = this.consumeStream(projectId, controller.signal, onMessage)
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        console.error(`SSE subscription failed for project ${projectId}:`, error);
      })
      .finally(() => {
        const current = this.subscriptions.get(projectId);
        if (current?.controller === controller) {
          this.subscriptions.delete(projectId);
        }
      });

    this.subscriptions.set(projectId, { controller, promise });
  }

  unsubscribe(projectId: string): void {
    const subscription = this.subscriptions.get(projectId);
    if (!subscription) {
      return;
    }

    subscription.controller.abort();
    this.subscriptions.delete(projectId);
  }

  unsubscribeAll(): void {
    for (const projectId of this.subscriptions.keys()) {
      this.unsubscribe(projectId);
    }
  }

  private async consumeStream(
    projectId: string,
    signal: AbortSignal,
    onMessage: (message: Message) => void
  ): Promise<void> {
    const response = await fetch(
      `${this.apiUrl}/projects/${encodeURIComponent(projectId)}/messages/stream`,
      {
        headers: { Accept: "text/event-stream" },
        signal,
      }
    );

    if (!response.ok) {
      throw new Error(`SSE request failed with status ${response.status}`);
    }

    if (!response.body) {
      throw new Error("SSE response body is missing");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        this.handleEvent(rawEvent, onMessage);
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }

    const trailing = buffer + decoder.decode();
    if (trailing.trim()) {
      this.handleEvent(trailing, onMessage);
    }
  }

  private handleEvent(rawEvent: string, onMessage: (message: Message) => void): void {
    const normalizedEvent = rawEvent.replace(/\r/g, "");
    const dataLines = normalizedEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) {
      return;
    }

    onMessage(JSON.parse(dataLines.join("\n")) as Message);
  }
}

import { EventEmitter } from "node:events";

type BridgePublisher = (lane: string, event: string, data: unknown) => void;

let publisher: BridgePublisher | null = null;
const laneRegistry = new Map<string, BridgedEventEmitter>();

/** Transport-loss signal shared without importing the PostgreSQL bridge. */
export const roomEventBridgeLossEvents = new EventEmitter();

/** Event emitter with an optional transport hook installed by the API server. */
export class BridgedEventEmitter extends EventEmitter {
  constructor(readonly lane: string) {
    super();
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const dispatched = super.emit(event, ...args);
    if (publisher && typeof event === "string") publisher(this.lane, event, args[0]);
    return dispatched;
  }

  emitLocal(event: string, data: unknown): boolean {
    return super.emit(event, data);
  }
}

export function createBridgedEmitter(lane: string): BridgedEventEmitter {
  const existing = laneRegistry.get(lane);
  if (existing) return existing;
  const emitter = new BridgedEventEmitter(lane);
  laneRegistry.set(lane, emitter);
  return emitter;
}

export function getBridgedEmitter(lane: string): BridgedEventEmitter | null {
  return laneRegistry.get(lane) ?? null;
}

export function setBridgedEventPublisher(next: BridgePublisher | null): void {
  publisher = next;
}

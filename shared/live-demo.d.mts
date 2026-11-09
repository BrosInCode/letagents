export const LIVE_DEMO_PROTOCOL: 'live_demo_v1';
export const LIVE_DEMO: Readonly<{
  width: number; maxHeight: number; cursorHz: number; serverCursorPerSecond: number; frameBytes: number;
  demosPerConnection: number; inkPointsPerFrame: number; inkFramesPerSecond: number; strokePoints: number;
  marksPerDemo: number; pinText: number; name: number; anchorPath: number;
}>;
export const LIVE_DEMO_COLORS: readonly string[];
export function liveDemoColorName(color: string): string;
export const DEMO_MARK_ID: RegExp;
export function newDemoMarkId(): string;
export const DEMO_MARK_RATE_LIMITED_TEXT: string;

export type LiveDemoPoint = [x: number, y: number];
export interface LiveDemoAnchor { path: string; dx: number; dy: number }
export interface LiveDemoPerson { cid: string; name: string; color: string }

export type LiveDemoClientFrame =
  | { t: 'join' | 'leave'; demo: string }
  | { t: 'cur'; demo: string; x: number; y: number }
  | { t: 'cur'; demo: string; gone: true }
  | { t: 'ink'; demo: string; id: string; pts: LiveDemoPoint[]; end?: true };

export interface DemoMarkBase {
  id: string;
  demo: string;
  author: { accountId: string; name: string; color: string };
  anchor: LiveDemoAnchor | null;
  createdAt: string;
}
export type DemoMark =
  | (DemoMarkBase & { kind: 'stroke'; points: LiveDemoPoint[] })
  | (DemoMarkBase & { kind: 'pin'; at: LiveDemoPoint; text: string });

export type DemoMarkInput =
  | { id?: string; demo: string; kind: 'stroke'; points: LiveDemoPoint[]; anchor: LiveDemoAnchor | null }
  | { id?: string; demo: string; kind: 'pin'; at: LiveDemoPoint; text: string; anchor: LiveDemoAnchor | null };

export type LiveDemoServerFrame =
  | { t: 'hello'; cid: string; name: string; color: string }
  | { t: 'presence'; demo: string; people: LiveDemoPerson[] }
  | { t: 'cur'; demo: string; cid: string; x: number; y: number }
  | { t: 'cur'; demo: string; cid: string; gone: true }
  | { t: 'ink'; demo: string; cid: string; id: string; pts: LiveDemoPoint[]; end?: true }
  | { t: 'mark'; demo: string; mark: DemoMark }
  | { t: 'unmark'; demo: string; id: string }
  | { t: 'error'; code: string; message: string; demo?: string; retry_after_ms?: number };

export function liveDemoKey(messageId: string, attachmentId: string): string | null;
export function isLiveDemoKey(value: unknown): value is string;
export function parseLiveDemoKey(value: unknown): { messageId: string; attachmentId: string } | null;
export function liveDemoColor(accountId: string): string;
export function parseLiveClientFrame(value: unknown): LiveDemoClientFrame | null;
export function parseLiveServerFrame(value: unknown): LiveDemoServerFrame | null;
export function parseDemoMark(value: unknown): DemoMark | null;
export function parseDemoMarkInput(value: unknown): DemoMarkInput | null;

export const DEMO_MARKS_FOR_AGENT: Readonly<{ pins: number; drawings: number }>;
export interface AgentDemoPin {
  number: number;
  author: string;
  created_at: string;
  note: string;
  x: number;
  y: number;
  element?: string;
  offset_in_element?: { x: number; y: number };
}
export interface AgentDemoDrawing {
  author: string;
  created_at: string;
  color: string;
  left: number;
  top: number;
  width: number;
  height: number;
}
export function demoMarksForAgent(marks: readonly DemoMark[], options?: { firstPin?: number }): {
  pins: AgentDemoPin[];
  drawings: AgentDemoDrawing[];
  pin_count: number;
  pins_not_listed?: number;
  next_first_pin?: number;
  drawings_not_listed?: number;
};
export const LIVE_DEMO_ANCHOR_DEPTH: number;
export function isLiveDemoAnchorStep(step: unknown): boolean;
export function isLiveDemoAnchorPath(path: unknown): boolean;
export function isHtmlDemoFile(file: { fileName?: string | null; mimeType?: string | null } | null | undefined): boolean;

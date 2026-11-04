// Live demos: the frames a desktop app and the API exchange over one WebSocket
// per room, and the saved marks. Coordinates are in demo space: the demo is laid
// out at LIVE_DEMO.width CSS px and scaled to fit, so a point is the same spot
// for every viewer.

export const LIVE_DEMO_PROTOCOL = 'live_demo_v1';
export const LIVE_DEMO = Object.freeze({
  width: 760,
  maxHeight: 20000,
  cursorHz: 20,
  serverCursorPerSecond: 30,
  frameBytes: 8192,
  demosPerConnection: 8,
  inkPointsPerFrame: 64,
  inkFramesPerSecond: 30,
  strokePoints: 2000,
  marksPerDemo: 500,
  pinText: 500,
  name: 80,
  anchorPath: 512,
});

const KEY_PART = /^(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/;
const STROKE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const COLORS = Object.freeze(['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f']);

export const LIVE_DEMO_COLORS = COLORS;

/** `<messageId>/<attachmentId>`: one demo in one room message. */
export function liveDemoKey(messageId, attachmentId) {
  const key = `${messageId}/${attachmentId}`;
  return isLiveDemoKey(key) ? key : null;
}

export function isLiveDemoKey(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return parts.length === 2 && parts.every((part) => KEY_PART.test(part));
}

export function parseLiveDemoKey(value) {
  if (!isLiveDemoKey(value)) return null;
  const [messageId, attachmentId] = value.split('/');
  return { messageId, attachmentId };
}

/** A stable colour for an account, the same in every app. */
export function liveDemoColor(accountId) {
  let hash = 0;
  for (const char of String(accountId)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isX(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= LIVE_DEMO.width;
}

function isY(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= LIVE_DEMO.maxHeight;
}

function isPoint(value) {
  return Array.isArray(value) && value.length === 2 && isX(value[0]) && isY(value[1]);
}

function isPoints(value, min, max) {
  return Array.isArray(value) && value.length >= min && value.length <= max && value.every(isPoint);
}

function isName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= LIVE_DEMO.name;
}

function isColor(value) {
  return typeof value === 'string' && COLORS.includes(value);
}

function isCid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(value);
}

function isAnchor(value) {
  return value === null || (isRecord(value) && hasOnlyKeys(value, ['path', 'dx', 'dy'])
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= LIVE_DEMO.anchorPath
    && typeof value.dx === 'number' && Number.isFinite(value.dx)
    && typeof value.dy === 'number' && Number.isFinite(value.dy));
}

/** A frame from a desktop app, or null. The server drops anything else. */
export function parseLiveClientFrame(value) {
  if (!isRecord(value) || !isLiveDemoKey(value.demo)) return null;
  switch (value.t) {
    case 'join':
    case 'leave':
      return hasOnlyKeys(value, ['t', 'demo']) ? { t: value.t, demo: value.demo } : null;
    case 'cur':
      if (value.gone === true) return hasOnlyKeys(value, ['t', 'demo', 'gone']) ? { t: 'cur', demo: value.demo, gone: true } : null;
      return hasOnlyKeys(value, ['t', 'demo', 'x', 'y']) && isX(value.x) && isY(value.y)
        ? { t: 'cur', demo: value.demo, x: value.x, y: value.y }
        : null;
    case 'ink':
      return hasOnlyKeys(value, ['t', 'demo', 'id', 'pts', 'end']) && STROKE_ID.test(value.id ?? '')
        && isPoints(value.pts, 0, LIVE_DEMO.inkPointsPerFrame) && (value.end === undefined || value.end === true)
        ? { t: 'ink', demo: value.demo, id: value.id, pts: value.pts, ...(value.end ? { end: true } : {}) }
        : null;
    default:
      return null;
  }
}

/** A saved mark as the server returns it, or null. */
export function parseDemoMark(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value.id)) return null;
  if (!isLiveDemoKey(value.demo) || typeof value.createdAt !== 'string') return null;
  const author = value.author;
  if (!isRecord(author) || typeof author.accountId !== 'string' || !isName(author.name) || !isColor(author.color)) return null;
  if (!isAnchor(value.anchor ?? null)) return null;
  if (value.kind === 'stroke') {
    return isPoints(value.points, 2, LIVE_DEMO.strokePoints) ? value : null;
  }
  if (value.kind === 'pin') {
    return isPoint(value.at) && typeof value.text === 'string' && value.text.length <= LIVE_DEMO.pinText ? value : null;
  }
  return null;
}

/** A new mark from a desktop app (REST body), or null. */
export function parseDemoMarkInput(value) {
  if (!isRecord(value) || !isLiveDemoKey(value.demo) || !isAnchor(value.anchor ?? null)) return null;
  if (value.kind === 'stroke') {
    return hasOnlyKeys(value, ['demo', 'kind', 'points', 'anchor']) && isPoints(value.points, 2, LIVE_DEMO.strokePoints)
      ? { demo: value.demo, kind: 'stroke', points: value.points, anchor: value.anchor ?? null }
      : null;
  }
  if (value.kind === 'pin') {
    return hasOnlyKeys(value, ['demo', 'kind', 'at', 'text', 'anchor']) && isPoint(value.at)
      && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= LIVE_DEMO.pinText
      ? { demo: value.demo, kind: 'pin', at: value.at, text: value.text, anchor: value.anchor ?? null }
      : null;
  }
  return null;
}

/** A frame from the server, or null. The desktop app ignores anything else. */
export function parseLiveServerFrame(value) {
  if (!isRecord(value)) return null;
  switch (value.t) {
    case 'hello':
      return isCid(value.cid) && isName(value.name) && isColor(value.color) ? value : null;
    case 'presence':
      return isLiveDemoKey(value.demo) && Array.isArray(value.people) && value.people.length <= 64
        && value.people.every((p) => isRecord(p) && isCid(p.cid) && isName(p.name) && isColor(p.color))
        ? value : null;
    case 'cur':
      if (!isLiveDemoKey(value.demo) || !isCid(value.cid)) return null;
      return value.gone === true || (isX(value.x) && isY(value.y)) ? value : null;
    case 'ink':
      return isLiveDemoKey(value.demo) && isCid(value.cid) && STROKE_ID.test(value.id ?? '')
        && isPoints(value.pts, 0, LIVE_DEMO.inkPointsPerFrame) ? value : null;
    case 'mark':
      return parseDemoMark(value.mark) && value.mark.demo === value.demo ? value : null;
    case 'unmark':
      return isLiveDemoKey(value.demo) && typeof value.id === 'string' ? value : null;
    case 'error':
      return typeof value.code === 'string' && typeof value.message === 'string' ? value : null;
    default:
      return null;
  }
}

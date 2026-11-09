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

// The palette's colours by name, in LIVE_DEMO_COLORS order, so a reader of text can match the ink.
const COLOR_NAMES = Object.freeze(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']);

/** A palette colour's plain name; "grey" for any other colour. */
export function liveDemoColorName(color) {
  const index = COLORS.indexOf(String(color).toLowerCase());
  return index >= 0 ? COLOR_NAMES[index] : 'grey';
}

/**
 * A mark's id: `dmk_` and 16 random bytes in base64url. The app picks it for a
 * new mark, so a save it sends again (its answer was lost) names the same mark,
 * and the server keeps one.
 */
export const DEMO_MARK_ID = /^dmk_[A-Za-z0-9_-]{22}$/;

export function newDemoMarkId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `dmk_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** The server's answer when one person changes marks too fast; the app waits and tries again. */
export const DEMO_MARK_RATE_LIMITED_TEXT = 'Too many changes to marks. Try again in a moment.';

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

/** The most steps a pin's element path has, from the element under it up. */
export const LIVE_DEMO_ANCHOR_DEPTH = 32;
// One step of a pin's element path: a tag (or *), then a unique id, or up to two classes and a place among its kind.
const ANCHOR_STEP = /^(?:\*|[A-Za-z][A-Za-z0-9-]{0,63})(?:#[A-Za-z_][A-Za-z0-9_-]{0,63}|(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,2}(?::nth-of-type\([1-9]\d{0,4}\))?)$/;

export function isLiveDemoAnchorStep(step) {
  return typeof step === 'string' && ANCHOR_STEP.test(step);
}

/**
 * A pin's element path as the desktop app makes it: steps joined by " > ",
 * each a plain CSS step. Nothing else is saved, so the path an agent reads
 * cannot carry other text.
 */
export function isLiveDemoAnchorPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > LIVE_DEMO.anchorPath) return false;
  const steps = path.split(' > ');
  return steps.length <= LIVE_DEMO_ANCHOR_DEPTH && steps.every(isLiveDemoAnchorStep);
}

/**
 * An HTML file that runs as a live demo in the desktop app: declared as HTML,
 * or, from an agent that attached it before HTML had a type, sent untyped
 * with an .html or .htm name.
 */
export function isHtmlDemoFile(file) {
  const type = String(file?.mimeType ?? '').toLowerCase().split(';')[0].trim();
  return type === 'text/html' || type === 'application/xhtml+xml'
    || ((type === '' || type === 'application/octet-stream') && /\.html?$/i.test(String(file?.fileName ?? '')));
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

/** A new mark from a desktop app (REST body), or null. `id` is optional: the server picks one without it. */
export function parseDemoMarkInput(value) {
  if (!isRecord(value) || !isLiveDemoKey(value.demo) || !isAnchor(value.anchor ?? null)) return null;
  // A new mark's element path must be one the app makes; marks saved before keep what they have.
  if (value.anchor && !isLiveDemoAnchorPath(value.anchor.path)) return null;
  if (value.id !== undefined && !(typeof value.id === 'string' && DEMO_MARK_ID.test(value.id))) return null;
  const id = value.id === undefined ? {} : { id: value.id };
  if (value.kind === 'stroke') {
    return hasOnlyKeys(value, ['id', 'demo', 'kind', 'points', 'anchor']) && isPoints(value.points, 2, LIVE_DEMO.strokePoints)
      ? { ...id, demo: value.demo, kind: 'stroke', points: value.points, anchor: value.anchor ?? null }
      : null;
  }
  if (value.kind === 'pin') {
    return hasOnlyKeys(value, ['id', 'demo', 'kind', 'at', 'text', 'anchor']) && isPoint(value.at)
      && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= LIVE_DEMO.pinText
      ? { ...id, demo: value.demo, kind: 'pin', at: value.at, text: value.text, anchor: value.anchor ?? null }
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

/** At most this many pins and drawings reach an agent at once; the rest are counted. */
export const DEMO_MARKS_FOR_AGENT = Object.freeze({ pins: 200, drawings: 100 });

const tenth = (value) => Math.round(value * 10) / 10;

function byAge(a, b) {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The saved marks of one demo as an agent reads them. Pins are numbered as
 * people see them on the demo (oldest first) and carry their note and, when
 * the app recorded it, the element under the pin. A drawing is the box its
 * stroke covers. Positions are in demo space: CSS px of the page laid out
 * LIVE_DEMO.width wide, from its top-left corner.
 */
export function demoMarksForAgent(marks, options = {}) {
  const firstPin = Number.isSafeInteger(options.firstPin) && options.firstPin > 1 ? options.firstPin : 1;
  const pins = [];
  const drawings = [];
  let pinCount = 0;
  let drawingCount = 0;
  for (const mark of [...marks].sort(byAge)) {
    const base = { author: mark.author.name, created_at: mark.createdAt };
    if (mark.kind === 'pin') {
      pinCount += 1;
      if (pinCount < firstPin || pins.length >= DEMO_MARKS_FOR_AGENT.pins) continue;
      // An element path in another shape (saved by something other than the app) is left out, never the pin.
      const element = mark.anchor && isLiveDemoAnchorPath(mark.anchor.path) ? mark.anchor : null;
      pins.push({
        number: pinCount, ...base, note: mark.text, x: mark.at[0], y: mark.at[1],
        ...(element ? { element: element.path, offset_in_element: { x: tenth(element.dx), y: tenth(element.dy) } } : {}),
      });
    } else {
      drawingCount += 1;
      // Drawings come with the first page of pins only, so a later page does not repeat them.
      if (firstPin > 1) continue;
      const xs = mark.points.map(([x]) => x);
      const ys = mark.points.map(([, y]) => y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      drawings.push({
        ...base, color: liveDemoColorName(mark.author.color),
        left: tenth(left), top: tenth(top), width: tenth(Math.max(...xs) - left), height: tenth(Math.max(...ys) - top),
      });
    }
  }
  // The newest drawings are kept when there are too many: they are the likeliest to be about now.
  const listedDrawings = drawings.slice(-DEMO_MARKS_FOR_AGENT.drawings);
  const pinsAfter = Math.max(0, pinCount - (firstPin - 1) - pins.length);
  return {
    pins, drawings: listedDrawings, pin_count: pinCount,
    ...(pinsAfter ? { pins_not_listed: pinsAfter, next_first_pin: firstPin + pins.length } : {}),
    ...(firstPin === 1 && drawingCount > listedDrawings.length ? { drawings_not_listed: drawingCount - listedDrawings.length } : {}),
  };
}

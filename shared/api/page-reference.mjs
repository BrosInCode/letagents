// The room page reference: what an agent needs to write a working page, made
// from the contract. The MCP tool `get_page_reference` returns it, and
// `docs/api/page-reference.md` holds the same text. An agent
// must be able to build a page from it alone, so it stays complete but short.
import { CAPABILITIES, CAPABILITY_NAMES, getCapability } from "./capabilities.mjs";
import { API_ERROR_CODES, API_VERSION, toJsonSchema } from "./core.mjs";
import { capabilitiesByInput } from "./agent-tools.mjs";
import { API_METHODS } from "./index.mjs";
import { DATA_SCOPE_CAPABILITIES } from "./data.mjs";
import { DATA_SCOPES, PAGE_MANIFEST_SCRIPT_TYPE, PAGE_SURFACES, PAGE_TITLE_MAX } from "./manifest.mjs";
import { PAGE_LIMITS } from "./pages.mjs";

/** @typedef {import("./index.mjs").KnownApiMethod} KnownApiMethod */

/** The server keeps at most this much HTML per page version. */
export const PAGE_HTML_MAX_BYTES = PAGE_LIMITS.htmlBytes;

/**
 * The `--la-*` CSS variables the app sets on a page's root element, in light
 * and dark values. The desktop's page theme must name the same ones (a test
 * compares them).
 */
export const PAGE_THEME_TOKEN_NAMES = Object.freeze([
  "--la-bg", "--la-bg-subtle", "--la-bg-card", "--la-bg-elevated",
  "--la-text", "--la-text-secondary", "--la-text-muted",
  "--la-border", "--la-border-strong", "--la-accent", "--la-accent-text",
  "--la-green", "--la-amber", "--la-red",
  "--la-font-sans", "--la-font-mono", "--la-radius",
]);

/**
 * The helpers the desktop bridge puts on `letagents.use(area)`: each local
 * name and the contract method it calls. The preload runs sandboxed and
 * cannot import this, so a test compares it with the preload's own tables.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const PAGE_AREA_HELPERS = Object.freeze({
  rooms: { get: "rooms.get" },
  people: { list: "people.list", viewer: "people.viewer" },
  agents: { list: "agents.list" },
  messages: { recent: "messages.recent", thread: "messages.thread" },
  board: { tasks: "tasks.list", get: "tasks.get", planning: "planning.get" },
  work_items: { search: "work_items.search", get: "work_items.get", history: "work_items.history" },
  git: { pullRequests: "git.pullRequests" },
  memory: { list: "memory.list" },
  jobs: { start: "jobs.start", get: "jobs.get", list: "jobs.list", cancel: "jobs.cancel" },
  intents: { propose: "intents.propose", get: "intents.get", list: "intents.list" },
});

/**
 * The watch helper an area offers: its local name and the read it keeps
 * running. `watch(input, cb)` takes the input first; `onChange(cb, input?)`
 * the callback first.
 * @type {Readonly<Record<string, readonly [string, string]>>}
 */
export const PAGE_AREA_WATCHES = Object.freeze({
  work_items: ["watch", "work_items.search"],
  board: ["onChange", "tasks.list"],
  jobs: ["onChange", "jobs.list"],
  intents: ["onChange", "intents.list"],
});

/** The reads a page may watch; the desktop's watch table must name the same ones (a test compares them). */
export const PAGE_WATCHABLE_READS = Object.freeze([
  "work_items.search", "work_items.get", "work_items.history",
  "data.list", "data.get", "jobs.list", "jobs.get", "intents.list", "intents.get",
  "tasks.list", "tasks.get", "planning.get",
]);

/** The room changes the desktop relays to `letagents.events.onChange`. */
export const PAGE_CHANGE_RESOURCES = Object.freeze(["work_items", "documents", "jobs", "intents", "pages", "tasks"]);

/** How the desktop runs watches; a test compares these with its constants. */
export const PAGE_WATCH_LIMITS = Object.freeze({ debounceMs: 250, workItemPollMs: 120_000, maxWatches: 16 });

/** Calls the desktop asks the viewer about first, in an app-drawn sheet. */
export const PAGE_CONFIRMED_METHODS = Object.freeze(["jobs.start", "intents.propose"]);

/**
 * Page management is for people and agents; a page knows itself through
 * `letagents.page.get()`.
 */
const AREAS_NOT_FOR_PAGES = new Set(["pages"]);

/**
 * The contract methods a page can call: every JSON method outside page
 * management whose capability a room admin can grant to a page.
 * @param {readonly KnownApiMethod[]} [methods]
 * @returns {KnownApiMethod[]}
 */
export function pageMethods(methods = API_METHODS) {
  return methods.filter((method) => method.response === "json"
    && !AREAS_NOT_FOR_PAGES.has(method.area)
    && /** @type {{ grantable?: boolean }} */ (getCapability(method.capability)).grantable !== false);
}

const POLICY_WORDS = Object.freeze({
  allow: "allowed",
  confirm: "the viewer confirms each call in an app sheet",
  approve: "a room admin approves",
  deny: "refused",
});

const POLICY_RULE_WORDS = Object.freeze({
  board_manager_mode: "allowed while Board Manager is off",
  own_tracker_connection: "allowed when the viewer's own tracker connection runs it",
});

/**
 * The whole reference, as Markdown.
 * @param {readonly KnownApiMethod[]} [methods]
 * @returns {string}
 */
export function pageReference(methods = API_METHODS) {
  const callable = pageMethods(methods).map((method) => ({ method, ...withoutSchemaUri(toJsonSchema(method)) }));
  const types = new TypeNamer();
  // Count every object shape first, so a shape used twice is named at its first use.
  for (const { method, input, output } of callable) {
    types.count(input, null, method.area);
    types.count(output, null, method.area);
  }
  const lines = callable.map(({ method, input, output }) => {
    const errors = method.errors.length ? ` Errors: ${method.errors.join(", ")}.` : "";
    const byInput = capabilitiesByInput(method);
    const capability = byInput ? `by ${byInput.field}: ${byInput.text}` : method.capability;
    return `- \`${method.name}(${types.render(input, "input")}) → ${types.render(output, "output")}\` [${capability}] `
      + `${firstSentences(method.description)}${errors}`;
  });

  /** @type {Map<string, string[]>} */
  const byPolicy = new Map();
  for (const name of CAPABILITY_NAMES) {
    const spec = getCapability(name);
    if (/** @type {{ grantable?: boolean }} */ (spec).grantable === false) continue;
    const words = POLICY_WORDS[spec.defaultPolicy];
    const rule = spec.policyRule ? ` (${POLICY_RULE_WORDS[spec.policyRule]})` : "";
    byPolicy.set(words, [...(byPolicy.get(words) ?? []), `${name}${rule}`]);
  }
  const capabilities = [...byPolicy].map(([words, names]) => `${words}: ${names.join(", ")}`).join("; ");
  const helpers = Object.entries(PAGE_AREA_HELPERS).map(([area, local]) => {
    const calls = Object.entries(local).map(([name, method]) => (name === method.split(".")[1] ? `\`${name}\`` : `\`${name}\` (${method})`));
    const watch = PAGE_AREA_WATCHES[area];
    const watchText = watch
      ? `; \`${watch[0]}(${watch[0] === "watch" ? "input, cb" : "cb, input?"})\` watches ${watch[1]}`
      : "";
    return `- \`use("${area}")\`: ${calls.join(", ")}${watchText}.`;
  });

  return `# LetAgents room page reference (api ${API_VERSION})

A room page is one HTML file that a team pins as a tab in a LetAgents room. It runs in a sandbox and reaches the room only through \`window.letagents\`.

## Rules
- One self-contained file, at most ${PAGE_HTML_MAX_BYTES / (1024 * 1024)} MB. All CSS and JavaScript inline. Images and fonts only as \`data:\` URLs (inline fonts; no web fonts).
- No network: fetch, XMLHttpRequest, WebSocket and outside scripts, styles, images and fonts are blocked. No forms, alert/confirm/prompt, pop-ups, downloads or navigation.
- Storage in the sandbox does not last: keep settings and shared data in data collections.
- The app sets its colours as CSS variables on \`<html>\`, light or dark: \`${PAGE_THEME_TOKEN_NAMES.join(", ")}\`.

## Manifest (required, exactly one)
\`\`\`html
<script type="${PAGE_MANIFEST_SCRIPT_TYPE}">
{ "api": ${API_VERSION}, "title": "Release desk", "surfaces": ["room.tab"], "capabilities": ["tasks.read", "git.read"] }
</script>
\`\`\`
- \`api\`: ${API_VERSION}. \`title\`: 1 to ${PAGE_TITLE_MAX} characters. \`surfaces\`: ${PAGE_SURFACES.map((s) => `"${s}"`).join(", ")}; this version shows "room.tab" only. \`owner\`: "room".
- \`capabilities\`: what the page may call; ask for the fewest. A room admin grants them when pinning; a call without one is \`not_granted\`. A new version that asks for more waits for a room admin.
- \`collections\`: \`{ ${DATA_SCOPES.map((scope) => `"${scope}": ["name"]`).join(", ")} }\`, the data the page keeps per scope (needs \`data.<scope>\`). A name is a-z, 0-9 and _, starts with a letter, at most 40 characters. A document id is 1 to 128 letters, digits, _ . : or -.
- \`workItemFields\`: tracker custom fields the page reads, such as "customfield_10027" (needs \`work_items.read\`).

Capabilities by what happens when the page uses one: ${capabilities}.

## window.letagents
Every call returns a Promise. A refusal rejects with \`{ code, message, retryAfterMs? }\`. Codes: ${API_ERROR_CODES.join(", ")}. \`declined\`: the viewer said no in the confirm sheet. After \`rate_limited\`, wait \`retryAfterMs\`.
- \`letagents.api.call(method, input?)\` or \`letagents.use(area).call(verb, input?)\`: a method below.
- Built in, no capability needed: \`letagents.page.get()\` → \`{ id, title, version }\`, \`letagents.viewer.get()\` → \`{ id, login, displayName }\`, and every \`letagents.ui\` call: \`ui.context()\` → \`{ surface, room: { id }, page, viewer }\`.
- \`letagents.ui.open(url)\`: https only, in the system browser; the first link to a new domain asks the viewer. \`letagents.ui.copy(text)\`: plain text. Both only within 5 s of a click or key press in the page.
- \`letagents.ui.theme.get()\` → \`{ mode: "light"|"dark", tokens }\`; \`letagents.ui.theme.onChange(fn)\` returns an unsubscribe function.
- ${PAGE_CONFIRMED_METHODS.map((m) => `\`${m}\``).join(" and ")} first show the viewer an app-drawn sheet with everything they send; a no rejects with \`declined\` and sends nothing. Only the page in the open tab may ask, one sheet at a time.
- At most a burst of 40 calls, then 10 a second.

## Helpers: letagents.use(area)
Each name calls the method in brackets (the same name when none), with that method's input: \`use("board").tasks({ status: "in_progress" })\`. \`use(area).call(verb, input?)\` calls the method \`<area>.<verb>\`.
${helpers.join("\n")}
- \`use("data").collection(scope, name)\` (${DATA_SCOPES.map((scope) => `${scope}: ${DATA_SCOPE_CAPABILITIES[scope]}`).join(", ")}): \`list(input?)\`, \`get(docId)\`, \`set(docId, data, options?)\`, \`update(docId, data, options?)\`, \`delete(docId, options?)\`, \`onSnapshot(cb, input?)\` watches data.list. \`options\`: \`{ ifRevision? }\`.

## Live updates
- A watch runs its read now, then again about ${PAGE_WATCH_LIMITS.debounceMs} ms after each change in the room; work item reads also run at least every ${PAGE_WATCH_LIMITS.workItemPollMs / 60_000} minutes. Each answer calls \`cb(result, error)\`: one of the two is null. A watch returns a function that stops it.
- \`letagents.watch(method, input, cb)\` watches any of: ${PAGE_WATCHABLE_READS.join(", ")}. It needs the method's capability.
- At most ${PAGE_WATCH_LIMITS.maxWatches} watches run per page; one more calls back with \`too_large\`.
- \`letagents.events.onChange(cb)\` gets \`{ resource }\` (${PAGE_CHANGE_RESOURCES.join(", ")}) when something changes, or \`{ resource: "*" }\` after a gap; returns an unsubscribe function.

## Methods
A field without a type is a string. \`?\` optional, \`= x\` default, \`<n>\` a number. Path fields are required.
${lines.join("\n")}
${types.definitions()}`;
}

/**
 * @param {{ input: Record<string, unknown>, output: Record<string, unknown> }} schemas
 */
function withoutSchemaUri({ input, output }) {
  const { $schema: _in, ...inputRest } = input;
  const { $schema: _out, ...outputRest } = output;
  return { input: inputRest, output: outputRest };
}

/**
 * The first sentence, and the second when the first is very short: enough to use
 * the method; the full text is in the agent tool's description.
 * @param {string} text
 */
function firstSentences(text) {
  const sentences = text.split(/(?<=\.)\s+(?=[A-Z`])/);
  const first = sentences[0] ?? text;
  return first.length < 40 && sentences[1] ? `${first} ${sentences[1]}` : first;
}

const SAFE_INT = Number.MAX_SAFE_INTEGER;
const QUERY_INT_TEXT = "^-?\\d{1,15}$";
/** Names too general to stand alone; the area goes in front (`items` → `WorkItem`). */
const GENERIC_NAMES = new Set(["Item", "Entry", "Result", "Value", "Root"]);

/**
 * Writes JSON Schema as short TypeScript-like text. An object shape used
 * more than once gets a name (`Task`), written once under "Types".
 */
class TypeNamer {
  constructor() {
    /** @type {Map<string, number>} */
    this.uses = new Map();
    /** @type {Map<string, string>} shape key → name */
    this.names = new Map();
    /** @type {Map<string, string>} name → definition text */
    this.defined = new Map();
    /** @type {Map<string, { name: string, area: string }>} shape key → name it would get */
    this.proposed = new Map();
  }

  /**
   * @param {any} schema
   * @param {string | null} key the property or array name it sits under
   * @param {string} area
   * @param {boolean} [item] whether it is an array's item
   */
  count(schema, key, area, item = false) {
    if (!schema || typeof schema !== "object") return;
    if (isNamedEnum(schema)) {
      const values = enumKey(schema);
      this.uses.set(values, (this.uses.get(values) ?? 0) + 1);
      if (!this.proposed.has(values) && key) this.proposed.set(values, { name: pascal(`${singular(area)}_${key}`), area });
      return;
    }
    if (isObjectShape(schema)) {
      const shape = JSON.stringify(schema);
      this.uses.set(shape, (this.uses.get(shape) ?? 0) + 1);
      // A method's whole output is named after its area (`Job`); a nested shape after its field.
      if (!this.proposed.has(shape)) this.proposed.set(shape, { name: key ? typeName(key, area, item) : pascal(singular(area)), area });
      for (const [name, property] of Object.entries(schema.properties)) this.count(property, name, area);
      return;
    }
    for (const alternative of schema.anyOf ?? schema.oneOf ?? []) this.count(alternative, key, area, item);
    if (schema.items) this.count(schema.items, key, area, true);
  }

  /**
   * @param {any} schema
   * @param {"input" | "output"} io
   * @returns {string}
   */
  render(schema, io) {
    return this.type(schema, io, true);
  }

  /**
   * @param {any} schema
   * @param {"input" | "output"} io
   * @param {boolean} top
   * @returns {string}
   */
  type(schema, io, top = false) {
    if (!schema || typeof schema !== "object") return "unknown";
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (alternatives) {
      // queryInt: a number or its text; the text form is for query strings only.
      const numbers = alternatives.filter((/** @type {any} */ alt) => alt.type === "integer" || alt.type === "number");
      const rest = alternatives.filter((/** @type {any} */ alt) => !numbers.includes(alt) && alt.pattern !== QUERY_INT_TEXT);
      const shown = numbers.length && rest.length === 0 ? numbers : alternatives;
      return [...new Set(shown.map((/** @type {any} */ alt) => this.type(alt, io)))].join("|");
    }
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    if (Array.isArray(schema.enum)) {
      const text = schema.enum.map((/** @type {unknown} */ value) => JSON.stringify(value)).join("|");
      // A long set of values used more than once (a task status) is written once, by name.
      const values = enumKey(schema);
      if (!isNamedEnum(schema) || (this.uses.get(values) ?? 0) < 2 || !this.proposed.has(values)) return text;
      const name = this.nameOf(values);
      if (!this.defined.has(name)) this.defined.set(name, text);
      return name;
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    return types.map((/** @type {string} */ type) => {
      switch (type) {
        case "string":
          return io === "input" && schema.pattern ? patternText(schema.pattern) : "string";
        case "integer":
        case "number": {
          const word = type === "integer" ? "int" : "number";
          const low = schema.minimum ?? schema.exclusiveMinimum;
          const high = schema.maximum ?? schema.exclusiveMaximum;
          return low !== undefined && high !== undefined && high < SAFE_INT && low > -SAFE_INT ? `${word} ${low}..${high}` : word;
        }
        case "boolean":
        case "null":
          return type;
        case "array": {
          const item = this.type(schema.items, io);
          return item.includes("|") && !item.startsWith("{") ? `(${item})[]` : `${item}[]`;
        }
        case "object":
          return this.object(schema, io, top);
        default:
          return "unknown";
      }
    }).join("|");
  }

  /**
   * @param {any} schema
   * @param {"input" | "output"} io
   * @param {boolean} top
   */
  object(schema, io, top) {
    if (!isObjectShape(schema)) {
      if (isSchema(schema.additionalProperties)) return `{ [key: string]: ${this.type(schema.additionalProperties, io)} }`;
      // A method without input fields: rooms.get().
      return top && io === "input" ? "" : "object";
    }
    const shape = JSON.stringify(schema);
    // Small shapes ({ key }) read better inline than as a name to look up.
    const named = !(top && io === "input") && (this.uses.get(shape) ?? 0) > 1 && Object.keys(schema.properties).length > 2
      ? this.nameOf(shape) : null;
    if (named && this.defined.has(named)) return named;
    if (named) this.defined.set(named, "");
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(([name, property]) => {
      const fallback = /** @type {any} */ (property).default;
      const optional = !required.has(name) || (io === "input" && fallback !== undefined);
      const type = this.type(property, io);
      // A bare field name is a string: most fields are, and the reference stays short.
      return `${name}${optional ? "?" : ""}${type === "string" && fallback === undefined ? "" : `: ${type}`}${io === "input" && fallback !== undefined ? ` = ${JSON.stringify(fallback)}` : ""}`;
    });
    const text = fields.length ? `{ ${fields.join(", ")} }` : "{}";
    if (!named) return text;
    this.defined.set(named, text);
    return named;
  }

  /** @param {string} shape */
  nameOf(shape) {
    const existing = this.names.get(shape);
    if (existing) return existing;
    const proposed = this.proposed.get(shape) ?? { name: "Shape", area: "" };
    const taken = new Set(this.names.values());
    // Two shapes under one name (a task's assignee, a ticket's assignee): the later one takes its area.
    let name = taken.has(proposed.name) ? `${pascal(singular(proposed.area))}${proposed.name}` : proposed.name;
    for (let n = 2; taken.has(name); n += 1) name = `${proposed.name}${n}`;
    this.names.set(shape, name);
    return name;
  }

  definitions() {
    const entries = [...this.defined].filter(([, text]) => text);
    return entries.length ? `\nTypes:\n${entries.map(([name, text]) => `- \`${name} = ${text}\``).join("\n")}\n` : "";
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isSchema(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {any} schema */
function isNamedEnum(schema) {
  // A short set ("person"|"agent"|"system") reads better inline than as a name to look up.
  return isSchema(schema) && Array.isArray(schema.enum) && schema.enum.length > 2 && JSON.stringify(schema.enum).length > 40;
}

/** @param {any} schema */
function enumKey(schema) {
  return `enum:${JSON.stringify(schema.enum)}`;
}

/** @param {any} schema */
function isObjectShape(schema) {
  return isSchema(schema) && schema.type === "object" && isSchema(schema.properties) && Object.keys(schema.properties).length > 0;
}

/**
 * `pullRequests` items → `PullRequest`, `checks` → `Checks`, `items` of work items → `WorkItem`.
 * @param {string} key
 * @param {string} area
 * @param {boolean} item
 */
function typeName(key, area, item) {
  const name = pascal(item ? singular(key) : key);
  return GENERIC_NAMES.has(name) ? pascal(singular(area)) : name;
}

/** @param {string} word */
function singular(word) {
  if (word === "people") return "person";
  return word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.replace(/(?<!s)s$/, "");
}

/**
 * An id pattern as an example (`^msg_[1-9]\\d*$` → `"msg_<n>"`); any other
 * pattern as a plain string.
 * @param {string} pattern
 */
function patternText(pattern) {
  const example = pattern.replace(/^\^|\$$/g, "").replace(/\[1-9\]\\d\*|\\d\{1,\d+\}|\\d\+/g, "<n>");
  // Other patterns are rules the server explains when an input breaks them.
  return /^[A-Za-z0-9_<>-]+$/.test(example) ? `"${example}"` : "string";
}

/** @param {string} text */
function pascal(text) {
  return text.split(/[_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

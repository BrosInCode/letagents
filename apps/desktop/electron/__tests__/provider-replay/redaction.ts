import type { JsonObject, JsonValue } from "./transcript.js";

/**
 * Redaction for recorded provider traffic. Transcripts are committed to a
 * public repository, so a recorder passes every frame through here before it
 * writes anything. Redaction replaces values; it never drops a frame, adds
 * one, or changes their order.
 *
 * It is a first pass, not a proof. It knows the literals the recorder gives
 * it and the shapes listed here, and nothing else. The final control is a
 * person who reads every distinct value of a new transcript before it is
 * committed.
 *
 * What is replaced, in every string and every object key, also inside a
 * string that is itself JSON:
 *
 * - exact secret values the recorder knows (launch environment, MCP config)
 * - the workspace, the temp directory, the repository and the home directory
 * - the machine's host names, and the user's full name
 * - the user name and single-word names, where they name the person: in a
 *   path, before `@`, or under a user-like key. Never as a bare word.
 * - email addresses
 * - tokens and keys, by shape: API keys (OpenAI, AWS, Google), GitHub
 *   tokens, JWTs, authorization values, long hex strings, `name=value` and
 *   URL query credentials
 * - everything under a key that names a credential, whatever its type
 * - provider and account ids: each real id maps to one fake id, the same one
 *   every time it appears, so frames still correlate
 * - names from the owner's own provider setup, where a whole value is one,
 *   and inside an `mcp__<server>__<tool>` name
 * - every value of an account frame, request, reply or notification: the
 *   keys stay, the values go
 */
export const REPLAY_WORKSPACE = "<workspace>";
export const REPLAY_TEMP_DIRECTORY = "<tmp>";
export const REPLAY_REPOSITORY = "<repo>";
export const REPLAY_HOME_DIRECTORY = "/home/replay-user";
export const REPLAY_USERNAME = "replay-user";
export const REPLAY_HOSTNAME = "replay-host";
export const REPLAY_EMAIL = "replay-user@example.com";
export const REPLAY_REDACTED = "<redacted>";
export const REPLAY_OWNER_SETUP_NAME = "owner-setup-name";

export interface ReplayRedactionContext {
  /** Every spelling of the workspace path, for example with and without `/private` on macOS. */
  workspacePaths: readonly string[];
  tempDirectories: readonly string[];
  repositoryPaths: readonly string[];
  homeDirectory: string;
  /**
   * Replaced where it names the person: in a path, before `@`, under a
   * user-like key. It is never replaced as a bare word, because a user name
   * can be an ordinary word that the protocol also uses, such as `user`. A
   * bare one that is left is reported by the leak check instead.
   */
  username: string;
  /**
   * Other strings that name the person: a full name, a Git author name, an
   * email's local part. A name of several words is replaced anywhere. A name
   * of one word is treated like the user name.
   */
  personalNames: readonly string[];
  hostnames: readonly string[];
  /** Exact values that must never be written, whatever their shape. */
  secrets: readonly string[];
  /**
   * Names the owner chose in their own provider setup, for example their MCP
   * servers. They are ordinary words, so only a value that is exactly one of
   * them, or an `mcp__<name>__` tool name, is replaced.
   */
  ownerSetupNames: readonly string[];
  /**
   * Methods that describe the owner's account: plan, usage, balance. Every
   * value in such a frame is blanked. A reply has no method of its own, so
   * the caller gives the method it answers.
   */
  accountMethods: readonly RegExp[];
}

const TOKEN_TAIL = "[A-Za-z0-9_-]";
const NOT_AFTER_WORD = "(?<![A-Za-z0-9])";
const NOT_BEFORE_WORD = "(?![A-Za-z0-9])";
/** Three characters start every base64url JSON object, so they start every JWT. */
const JWT_PREFIX = Buffer.from('{"a').toString("base64url").slice(0, 3);
/** Credential shapes: a known prefix, its separator, and how long the rest must be. */
const TOKEN_SHAPE_TABLE: ReadonlyArray<{ prefix: string; separator: string; minLength: number }> = [
  { prefix: "sk", separator: "-", minLength: 8 },
  { prefix: "gh[pousr]", separator: "_", minLength: 16 },
  { prefix: "github_pat", separator: "_", minLength: 16 },
  { prefix: "xox[abprs]", separator: "-", minLength: 8 },
];
const TOKEN_SHAPE_SOURCES: readonly string[] = [
  ...TOKEN_SHAPE_TABLE.map(({ prefix, separator, minLength }) =>
    `${NOT_AFTER_WORD}${prefix}${separator}${TOKEN_TAIL}{${minLength},}`),
  `${NOT_AFTER_WORD}${JWT_PREFIX}${TOKEN_TAIL}{8,}\\.${TOKEN_TAIL}{4,}(?:\\.${TOKEN_TAIL}*)?`,
  // AWS access key ids, and Google API keys.
  `${NOT_AFTER_WORD}A(?:KIA|SIA|GPA|IDA|ROA|NPA)[0-9A-Z]{16}${NOT_BEFORE_WORD}`,
  `${NOT_AFTER_WORD}AIza${TOKEN_TAIL}{35}${NOT_BEFORE_WORD}`,
];
/** The value after an HTTP authorization scheme. */
const AUTHORIZATION_VALUE_SOURCE = "\\b(bearer)\\s+[A-Za-z0-9._~+/=-]{16,}";
const CREDENTIAL_WORDS = "password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|private[_-]?key"
  + "|(?:access|refresh|id|auth|session|bearer)[_-]?token|token|authorization|cookie";
/** A credential written into text: `password=…`, `"apiKey": "…"`, `LETAGENTS_TOKEN=…`. */
const CREDENTIAL_ASSIGNMENT_SOURCE = `(${NOT_AFTER_WORD}(?:${CREDENTIAL_WORDS})\\\\?["']?\\s*[:=]\\s*\\\\?["']?)`
  + "(?!(?:bearer|basic)\\b)([^\\\\\\s\"',;&}\\]<]+)";
/** A credential in a URL query: `?api_key=…`. */
const QUERY_CREDENTIAL_SOURCE = `([?&](?:${CREDENTIAL_WORDS}|key|auth|signature|sig|code)=)([^&#\\s"'<>]+)`;
/** A long run of hex digits: a key, a digest, a session secret. Looked for after ids are mapped. */
const LONG_HEX_SOURCE = `${NOT_AFTER_WORD}[0-9a-fA-F]{32,}${NOT_BEFORE_WORD}`;
const EMAIL_SOURCE = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+";
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Provider object ids: a short lowercase prefix, an underscore, and a long opaque tail. */
const PREFIXED_ID_SOURCE = "\\b([a-z]{2,8})_([A-Za-z0-9]{20,})\\b";
/** Any user's home folder, on macOS or Linux. */
const HOME_ROOT_SOURCE = "(?:/Users|/home)/[^/\\s\"'`<>:,;)(\\][}{]+";

/**
 * Keys are compared as lowercase words joined by `_`: `accessToken` and
 * `access-token` both read `access_token`.
 */
function keyWords(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}
/**
 * Keys that hold a credential. Everything under one is blanked, whatever its
 * type. Counters such as `inputTokens` and `tokenUsage` are not credentials:
 * only a key that ends in the word `token` is.
 */
const CREDENTIAL_KEY = /(?:^|_)(?:authorization|cookies?|credentials?|password|passwd|secrets?|bearer|apikey|api_key|access_key|private_key|signing_key|session_key)(?:_|$)|(?:^|_)token$/;
/** Keys whose value identifies an account, an installation or an organization. */
const IDENTITY_KEY = /(?:^|_)(?:account|installation|organi[sz]ation|org|user|device|machine|tenant|customer)_id$/;
/** Keys whose value names a person. */
const PERSON_KEY = /^(?:user|username|user_name|login|logname|owner|author|committer|account_name|display_name|full_name|real_name)$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The values worth looking for, the longest first. With `anyCase`, two
 * spellings that differ only in case are one value: use it only for values
 * that are matched without regard to case.
 */
function distinct(values: readonly string[], minLength: number, anyCase = false): string[] {
  const kept = new Map<string, string>();
  for (const value of values.map((entry) => entry.trim()).filter((entry) => entry.length >= minLength)) {
    const key = anyCase ? value.toLowerCase() : value;
    if (!kept.has(key)) kept.set(key, value);
  }
  return [...kept.values()].sort((left, right) => right.length - left.length);
}

/** A whole word: not inside a longer run of letters or digits. */
function wholeWord(value: string): string {
  return `${NOT_AFTER_WORD}${escapeRegExp(value)}${NOT_BEFORE_WORD}`;
}

/** The user name and every one-word personal name: words that may also be ordinary words. */
function personWords(context: ReplayRedactionContext): string[] {
  return distinct([context.username, ...context.personalNames.filter((name) => !/\s/.test(name.trim()))], 2, true);
}

function personPhrases(context: ReplayRedactionContext): string[] {
  return distinct(context.personalNames.filter((name) => /\s/.test(name.trim())), 3);
}

/** Where a word names a person: a path segment, a dash-joined home path, or a login before `@`. */
function personContextSource(word: string): string {
  const name = escapeRegExp(word);
  return `(?<=[/\\\\])${name}(?=$|[^A-Za-z0-9._-])`
    + `|(?<=-(?:Users|home)-)${name}(?=$|[^A-Za-z0-9])`
    + `|(?<![A-Za-z0-9._-])${name}(?=@)`;
}

/** What redaction writes. A later rule must not read one of these as real text and redact it again. */
const PLACEHOLDERS: readonly string[] = [
  REPLAY_HOME_DIRECTORY, REPLAY_EMAIL, REPLAY_USERNAME, REPLAY_HOSTNAME, REPLAY_OWNER_SETUP_NAME,
  REPLAY_REDACTED, REPLAY_WORKSPACE, REPLAY_TEMP_DIRECTORY, REPLAY_REPOSITORY,
];
const PLACEHOLDER_SOURCE = `(${[...PLACEHOLDERS].sort((left, right) => right.length - left.length).map(escapeRegExp).join("|")}|<redacted-hex-\\d+>)`;

/** Apply a change to the text between placeholders, and leave the placeholders as they are. */
function outsidePlaceholders(text: string, change: (part: string) => string): string {
  return text.split(new RegExp(PLACEHOLDER_SOURCE)).map((part, index) => (index % 2 ? part : change(part))).join("");
}

/** How a server name reads inside an `mcp__<server>__<tool>` name: as it is, or with `_` for other characters. */
function mcpToolNameSpellings(name: string): string[] {
  return [...new Set([name, name.replace(/[^A-Za-z0-9_]/g, "_")])];
}

/** A string that is a JSON object or array, parsed. Null for every other string. */
function embeddedJson(text: string): JsonValue | null {
  const trimmed = text.trim();
  if (trimmed.length < 2 || !/^[{[]/.test(trimmed)) return null;
  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const MAX_EMBEDDED_JSON_DEPTH = 4;
/** The parts of a JSON-RPC frame that carry what a method says. The rest is its envelope. */
const ACCOUNT_FRAME_PARTS: ReadonlySet<string> = new Set(["params", "result", "error"]);

export class ReplayRedactor {
  /** How many values each rule replaced. A recorder prints it, so a reader sees what was found. */
  readonly counts: Record<string, number> = {};
  private readonly uuids = new Map<string, string>();
  private readonly prefixedIds = new Map<string, string>();
  private readonly hexRuns = new Map<string, string>();
  private readonly identities = new Map<string, string>();
  private readonly literalRules: Array<{ rule: string; pattern: RegExp; replacement: string }>;
  /** A person's word in a place that names the person. */
  private readonly personContextRule: RegExp | null;
  /** A person's word anywhere. Used only under a key that names a person. */
  private readonly personWordRule: RegExp | null;
  private readonly ownerSetupNames: ReadonlySet<string>;
  private readonly ownerSetupFakes = new Map<string, string>();
  private readonly accountMethods: readonly RegExp[];
  /** The methods of the requests seen so far, by request id, from either side. */
  private readonly requestMethods = new Map<string, Set<string>>();

  constructor(context: ReplayRedactionContext) {
    this.ownerSetupNames = new Set(context.ownerSetupNames);
    this.accountMethods = context.accountMethods;
    const literal = (rule: string, values: readonly string[], replacement: string, word = false) =>
      distinct(values, 3).map((value) => ({
        rule,
        pattern: new RegExp(word ? wholeWord(value) : escapeRegExp(value), word ? "gi" : "g"),
        replacement,
      }));
    const words = personWords(context);
    this.personWordRule = words.length ? new RegExp(words.map(wholeWord).join("|"), "gi") : null;
    this.personContextRule = words.length ? new RegExp(words.map(personContextSource).join("|"), "gi") : null;
    this.literalRules = [
      ...literal("secret", context.secrets, REPLAY_REDACTED),
      ...literal("workspace", context.workspacePaths, REPLAY_WORKSPACE),
      ...literal("repository", context.repositoryPaths, REPLAY_REPOSITORY),
      ...literal("temp-directory", context.tempDirectories, REPLAY_TEMP_DIRECTORY),
      ...literal("home-directory", [context.homeDirectory], REPLAY_HOME_DIRECTORY),
      { rule: "home-directory", pattern: new RegExp(HOME_ROOT_SOURCE, "g"), replacement: REPLAY_HOME_DIRECTORY },
      ...literal("hostname", context.hostnames, REPLAY_HOSTNAME, true),
      ...literal("personal-name", personPhrases(context), REPLAY_USERNAME, true),
    ];
  }

  /**
   * A redacted copy of one frame. The frame given is not changed. `label` is
   * the method a reply answers; a request or notification carries its own.
   */
  redactFrame(frame: JsonObject, label?: string): JsonObject {
    const id = frame.id === undefined ? null : JSON.stringify(frame.id);
    const own = typeof frame.method === "string" ? frame.method : null;
    if (own !== null && id !== null) {
      this.requestMethods.set(id, (this.requestMethods.get(id) ?? new Set()).add(own));
    }
    // A reply is about the account when the method it answers is. The label says which method that
    // is. Without a label, every request seen with this id counts: both sides number their requests.
    const methods = own !== null ? [own] : label !== undefined ? [label] : [...(this.requestMethods.get(id ?? "") ?? [])];
    if (!methods.some((method) => this.accountMethods.some((pattern) => pattern.test(method)))) {
      return this.redactValue(frame, null, 0) as JsonObject;
    }
    // An account frame keeps its envelope. What it says about the account is blanked.
    this.count("account-frame");
    return this.copyObject(frame, (child, key) =>
      ACCOUNT_FRAME_PARTS.has(key) ? this.blank(child) : this.redactValue(child, key, 0));
  }

  redactText(text: string): string {
    return this.redactString(text);
  }

  private count(rule: string): void {
    this.counts[rule] = (this.counts[rule] ?? 0) + 1;
  }

  /** The same shape with no values: text is redacted, a number is 0, a flag is false. */
  private blank(value: JsonValue): JsonValue {
    if (typeof value === "string") return value ? REPLAY_REDACTED : value;
    if (typeof value === "number") return 0;
    if (typeof value === "boolean") return false;
    if (Array.isArray(value)) return value.map((item) => this.blank(item));
    if (value !== null && typeof value === "object") return this.copyObject(value, (child) => this.blank(child));
    return value;
  }

  /** Two keys that redact to the same text stay two keys: the later one gets a number. */
  private copyObject(value: JsonObject, redactChild: (child: JsonValue, key: string) => JsonValue): JsonObject {
    const copy: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const redactedKey = this.ownerSetupName(key) ?? this.redactString(key);
      let unique = redactedKey;
      for (let copyNumber = 2; Object.hasOwn(copy, unique); copyNumber += 1) unique = `${redactedKey} (${copyNumber})`;
      if (unique !== redactedKey) this.count("key-collision");
      copy[unique] = redactChild(child, key);
    }
    return copy;
  }

  private redactValue(value: JsonValue, key: string | null, depth: number): JsonValue {
    const words = key === null ? "" : keyWords(key);
    if (value !== null && value !== "" && CREDENTIAL_KEY.test(words)) {
      this.count("credential-key");
      return this.blank(value);
    }
    if ((typeof value === "string" && value) || typeof value === "number") {
      if (IDENTITY_KEY.test(words)) return this.identity(words, String(value));
    }
    if (typeof value === "string") {
      const owned = this.ownerSetupName(value);
      if (owned) return owned;
      const inside = depth < MAX_EMBEDDED_JSON_DEPTH ? embeddedJson(value) : null;
      if (inside !== null) {
        // The text is JSON: redact it as data, so its keys count. Text with nothing to redact is kept as it is.
        const redacted = this.redactValue(inside, null, depth + 1);
        if (JSON.stringify(redacted) !== JSON.stringify(inside)) return JSON.stringify(redacted);
      }
      const text = this.redactString(value);
      const personWord = this.personWordRule;
      if (!PERSON_KEY.test(words) || !personWord) return text;
      return outsidePlaceholders(text, (part) => part.replace(personWord, () => this.personName()));
    }
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item, key, depth));
    if (value !== null && typeof value === "object") {
      return this.copyObject(value, (child, childKey) => this.redactValue(child, childKey, depth));
    }
    return value;
  }

  private personName(): string {
    this.count("username");
    return REPLAY_USERNAME;
  }

  private ownerSetupName(value: string): string | null {
    if (!this.ownerSetupNames.has(value)) return null;
    return this.ownerSetupFake(value);
  }

  private ownerSetupFake(name: string): string {
    let fake = this.ownerSetupFakes.get(name);
    if (!fake) {
      fake = `${REPLAY_OWNER_SETUP_NAME}-${this.ownerSetupFakes.size + 1}`;
      this.ownerSetupFakes.set(name, fake);
      this.count("owner-setup-name");
    }
    return fake;
  }

  /** An account-like id keeps its key's kind and gets a number: `installation-id-1`. */
  private identity(keyWordsOfId: string, value: string): string {
    // A UUID is mapped like every other UUID, so it still matches where the same id appears under another key.
    if (new RegExp(`^${UUID_SOURCE}$`, "i").test(value)) return this.redactString(value);
    const kind = keyWordsOfId.replace(/_/g, "-");
    const known = this.identities.get(`${kind}\u0000${value}`);
    if (known) return known;
    const sameKind = [...this.identities.keys()].filter((entry) => entry.startsWith(`${kind}\u0000`)).length;
    const fake = `${kind}-${sameKind + 1}`;
    this.identities.set(`${kind}\u0000${value}`, fake);
    this.count("identity-key");
    return fake;
  }

  /** One stable fake for each real value of a kind, numbered in order of first appearance. */
  private stableFake(known: Map<string, string>, real: string, rule: string, make: (index: number) => string): string {
    let fake = known.get(real);
    if (!fake) {
      fake = make(known.size + 1);
      known.set(real, fake);
      this.count(rule);
    }
    return fake;
  }

  private redactString(input: string): string {
    let text = input;
    for (const { rule, pattern, replacement } of this.literalRules) {
      text = text.replace(pattern, (match) => {
        if (match !== replacement) this.count(rule);
        return replacement;
      });
    }
    const personContext = this.personContextRule;
    if (personContext) text = outsidePlaceholders(text, (part) => part.replace(personContext, () => this.personName()));
    for (const name of this.ownerSetupNames) {
      for (const spelling of mcpToolNameSpellings(name)) {
        if (text.includes(`mcp__${spelling}__`)) text = text.split(`mcp__${spelling}__`).join(`mcp__${this.ownerSetupFake(name)}__`);
      }
    }
    text = text.replace(new RegExp(EMAIL_SOURCE, "g"), (match) => {
      if (match === REPLAY_EMAIL) return match;
      this.count("email");
      return REPLAY_EMAIL;
    });
    text = text.replace(new RegExp(AUTHORIZATION_VALUE_SOURCE, "gi"), (_match, scheme: string) => {
      this.count("token");
      return `${scheme} ${REPLAY_REDACTED}`;
    });
    // The URL rule first: it knows where a query value ends.
    for (const source of [QUERY_CREDENTIAL_SOURCE, CREDENTIAL_ASSIGNMENT_SOURCE]) {
      text = text.replace(new RegExp(source, "gi"), (_match, name: string) => {
        this.count("credential-text");
        return `${name}${REPLAY_REDACTED}`;
      });
    }
    for (const source of TOKEN_SHAPE_SOURCES) {
      text = text.replace(new RegExp(source, "g"), () => { this.count("token"); return REPLAY_REDACTED; });
    }
    text = text.replace(new RegExp(`\\b${UUID_SOURCE}\\b`, "gi"), (match) =>
      this.stableFake(this.uuids, match.toLowerCase(), "uuid",
        (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    text = text.replace(new RegExp(PREFIXED_ID_SOURCE, "g"), (match, prefix: string) => {
      const sameKind = [...this.prefixedIds.values()].filter((entry) => entry.startsWith(`${prefix}_replay`)).length;
      return this.stableFake(this.prefixedIds, match, "provider-id",
        () => `${prefix}_replay${String(sameKind + 1).padStart(4, "0")}`);
    });
    // What is still a long hex run is no id this code knows. It keeps its identity, and loses its value.
    text = text.replace(new RegExp(LONG_HEX_SOURCE, "g"), (match) =>
      this.stableFake(this.hexRuns, match.toLowerCase(), "long-hex", (index) => `<redacted-hex-${index}>`));
    return text;
  }
}

export interface ReplayLeak {
  rule: string;
  /** Where the value was found. The value itself is never reported. */
  line: number;
  /** The keys that lead to it inside the entry, for example `frame.params.thread.path`. */
  path: string;
}

/** What redaction writes for an id: a numbered fake of its kind, or a fake UUID. */
const FAKE_UUID_SOURCE = "00000000-0000-4000-8000-\\d{12}";
function isFakeIdentity(value: JsonValue, keyWordsOfId: string): boolean {
  if (value === null || value === "") return true;
  return typeof value === "string"
    && new RegExp(`^(?:${escapeRegExp(keyWordsOfId.replace(/_/g, "-"))}-\\d+|${FAKE_UUID_SOURCE}|${escapeRegExp(REPLAY_REDACTED)})$`).test(value);
}

function isBlank(value: JsonValue): boolean {
  if (typeof value === "string") return value === "" || value === REPLAY_REDACTED;
  if (typeof value === "number") return value === 0;
  if (typeof value === "boolean") return value === false;
  if (Array.isArray(value)) return value.every(isBlank);
  if (value !== null && typeof value === "object") return Object.values(value).every(isBlank);
  return true;
}

/**
 * A last check on the text a recorder is about to write. It looks for what
 * redaction should already have removed, and a recorder that finds anything
 * writes nothing. Like redaction, it finds only what it knows how to look for.
 */
export function findReplayLeaks(text: string, context: ReplayRedactionContext): ReplayLeak[] {
  const leaks: ReplayLeak[] = [];
  const reported = new Set<string>();
  /** One report for each rule at each place, however many of its patterns matched there. */
  const report = (rule: string, line: number, path: string) => {
    const key = `${rule}\u0000${line}\u0000${path}`;
    if (reported.has(key)) return;
    reported.add(key);
    leaks.push({ rule, line, path });
  };
  const literals: Array<[string, string[]]> = [
    ["secret", distinct(context.secrets, 3)],
    ["home-directory", distinct([context.homeDirectory], 3)],
    ["personal-name", personPhrases(context)],
    ["workspace", distinct(context.workspacePaths, 3)],
    ["repository", distinct(context.repositoryPaths, 3)],
  ];
  const wholeWords: Array<[string, RegExp]> = [
    ...distinct(context.hostnames, 3).map((value): [string, RegExp] => ["hostname", new RegExp(wholeWord(value), "i")]),
    // A bare user name is not redacted, so one that is left is found here, whatever its length.
    ...personWords(context).map((value): [string, RegExp] => ["username", new RegExp(wholeWord(value), "i")]),
  ];
  const shapes: Array<[string, RegExp]> = [
    ["home-directory", new RegExp(HOME_ROOT_SOURCE)],
    ["email", new RegExp(EMAIL_SOURCE)],
    ["token", new RegExp(AUTHORIZATION_VALUE_SOURCE, "i")],
    ["credential-text", new RegExp(CREDENTIAL_ASSIGNMENT_SOURCE, "i")],
    ["credential-text", new RegExp(QUERY_CREDENTIAL_SOURCE, "i")],
    ["long-hex", new RegExp(LONG_HEX_SOURCE)],
    ...TOKEN_SHAPE_SOURCES.map((source): [string, RegExp] => ["token", new RegExp(source)]),
  ];
  const ownerToolNames = context.ownerSetupNames.flatMap(mcpToolNameSpellings).map((name) => `mcp__${name}__`);

  const checkText = (raw: string, line: number, path: string) => {
    const found = (rule: string) => { report(rule, line, path); };
    if (context.ownerSetupNames.includes(raw)) found("owner-setup-name");
    if (ownerToolNames.some((name) => raw.includes(name))) found("owner-setup-name");
    // What redaction wrote is not a leak, even when a real value happens to be part of it. Each
    // placeholder becomes a mark that no rule reads as a value, so the text around it does not join up.
    const content = raw.replace(new RegExp(PLACEHOLDER_SOURCE, "g"), "<>");
    const lower = content.toLowerCase();
    for (const [rule, values] of literals) {
      if (values.some((value) => lower.includes(value.toLowerCase()))) found(rule);
    }
    for (const [rule, pattern] of [...wholeWords, ...shapes]) {
      if (pattern.test(content)) found(rule);
    }
    // An id that redaction did not map is a real one.
    const realIds = raw.replace(new RegExp(FAKE_UUID_SOURCE, "g"), "<>");
    if (new RegExp(`\\b${UUID_SOURCE}\\b`, "i").test(realIds)) found("uuid");
    if (new RegExp(PREFIXED_ID_SOURCE).test(content)) found("provider-id");
  };
  /** `structural` is off for the header: its keys are the recorder's own words, not provider data. */
  const checkValue = (value: JsonValue, key: string | null, line: number, path: string, structural: boolean, depth: number) => {
    const words = key === null ? "" : keyWords(key);
    if (structural && CREDENTIAL_KEY.test(words) && !isBlank(value)) report("credential-key", line, path);
    if (structural && IDENTITY_KEY.test(words) && !Array.isArray(value) && (value === null || typeof value !== "object")
      && !isFakeIdentity(value, words)) {
      report("identity-key", line, path);
    }
    if (typeof value === "string") {
      checkText(value, line, path);
      const inside = depth < MAX_EMBEDDED_JSON_DEPTH ? embeddedJson(value) : null;
      if (inside !== null) checkValue(inside, null, line, `${path}<json>`, structural, depth + 1);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => checkValue(item, key, line, `${path}[${index}]`, structural, depth));
    } else if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${childKey}` : childKey;
        checkText(childKey, line, `${childPath} (key)`);
        checkValue(child, childKey, line, childPath, structural, depth);
      }
    }
  };

  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    const line = index + 1;
    let entry: JsonValue;
    try {
      entry = JSON.parse(raw) as JsonValue;
    } catch {
      checkText(raw, line, "");
      return;
    }
    const isEntry = entry !== null && typeof entry === "object" && !Array.isArray(entry);
    const frame = isEntry ? (entry as JsonObject).frame : undefined;
    if (isEntry && frame !== null && typeof frame === "object" && !Array.isArray(frame)) {
      const method = typeof frame.method === "string" ? frame.method : (entry as JsonObject).label;
      if (typeof method === "string" && context.accountMethods.some((pattern) => pattern.test(method))) {
        for (const part of ACCOUNT_FRAME_PARTS) {
          if (frame[part] !== undefined && !isBlank(frame[part]!)) report("account-frame", line, `frame.${part}`);
        }
      }
    }
    checkValue(entry, null, line, "", !(isEntry && (entry as JsonObject).type === "transcript_start"), 0);
  });
  return leaks;
}

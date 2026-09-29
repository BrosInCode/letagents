/**
 * Automatic review of an agent's shell commands.
 *
 * Two layers decide whether a command may run without asking a person:
 *
 *  1. Fixed rules in this file. They allow only command shapes they can read
 *     in full: a short list of programs, written in plain words, each with
 *     the options it is known to take, and arguments that stay inside the
 *     project. Everything else goes to a person and is never sent to a model.
 *  2. Jev, a decision model, sorts what is left by kind. Reading and the
 *     project's own checks may run.
 *
 * The rules name what is allowed, not what is forbidden, because a shell and
 * its programs can spell a forbidden thing in more ways than a list can hold.
 * They are still best effort: they read the command's text, not what a
 * program does with it. A project's own scripts and tests run whatever the
 * project defines.
 *
 * Every other outcome (no rule allows it, a low score, a missing or malformed
 * answer, a timeout) means "ask a person". Nothing here ever denies a command
 * or decides that a command is dangerous: it only declines to decide.
 *
 * Pure: no I/O, no clock, no environment.
 */

/** How much of the answer must fall on reading or on the project's own checks. */
export const PERMISSION_REVIEW_APPROVE_AT = 0.9;
/** How much of the answer may fall on risky. */
export const PERMISSION_REVIEW_RISKY_AT_MOST = 0.1;
export const PERMISSION_REVIEW_MAX_COMMANDS = 16;
export const PERMISSION_REVIEW_MAX_COMMAND_CHARS = 2_000;
export const PERMISSION_REVIEW_MAX_PROJECT_CHARS = 1_024;

/** The scores of the four kinds must add up to a whole, give or take this. */
const KIND_TOTAL_TOLERANCE = 0.02;

/** Characters a word may hold outside quotes. None of them means anything to a shell. */
const PLAIN = /^[A-Za-z0-9_\-./:=@,+%~]$/;
/** Inside single quotes nothing is special, so any printable character but the quote itself. */
const SINGLE_QUOTED = /^[\x20-\x26\x28-\x7e]*$/;
/** Inside double quotes a shell still expands `$`, backticks, `\` and `!`. */
const DOUBLE_QUOTED = /^[\x20\x23\x25-\x5b\x5d-\x5f\x61-\x7e]*$/;
/** Joining or discarding an output stream names no file a command could overwrite. */
const STREAM = /^(?:2>&1|[12]?>>? ?\/dev\/null)(?=[ \t\n;|&]|$)/;

const CREDENTIAL = /(?:^|[/=:,])\.(?:env|envrc|ssh|aws|gnupg|kube|docker|dockercfg|npmrc|pypirc|netrc|pgpass|git-credentials|azure|boto|s3cfg|my\.cnf)(?:$|[/._-])|\.(?:env|pem|key|crt|cer|p12|pfx|jks|keystore|kdbx|tfstate|tfvars)(?:$|[.,:])|credential|secret|passw|token|api[_-]?key|private[_-]?key|service[_-]?account|kubeconfig|wallet|_history|id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts|keychain/i;

/** A script, target, or file named for an action that ships, removes, or reaches production. */
const CONSEQUENTIAL_NAME = /deploy|release|publish|rollback|destroy|teardown|wipe|purge|drop|nuke|erase|delete|remove|reset|clean|clear|uninstall|install|migrat|seed|prod|backup|restore|upload|email|notify|charge|refund|invoice|payment|(?:^|[^a-z])(?:env|db|sync|ship|push|rm)(?:$|[^a-z])/i;

function isText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function normalizedProject(project) {
  if (!isText(project, PERMISSION_REVIEW_MAX_PROJECT_CHARS) || !/^[\x21-\x7e]+$/.test(project)) return null;
  const trimmed = project.replace(/\/+$/, "");
  return trimmed.startsWith("/") && trimmed.length > 1
    && trimmed.split("/").slice(1).every((part) => part && part !== "." && part !== "..") ? trimmed : null;
}

/**
 * Split a command into simple commands of words, or return null when any part
 * of it is written in a way these rules do not read: expansion, substitution,
 * escaping, grouping, a redirect to a file, a background job, a comment, or a
 * quote joined to other text.
 */
function readCommands(command) {
  // Printable ASCII, tab, and new line only. Anything else can look like a space and not be one.
  if (!/^[\x20-\x7e\t\n]+$/.test(command)) return null;
  const commands = [{ words: [], fed: false }];
  const current = () => commands[commands.length - 1];
  const boundary = (index) => index >= command.length || " \t\n;|&".includes(command[index]);
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === " " || char === "\t") { index += 1; continue; }
    const rest = command.slice(index);
    const stream = STREAM.exec(rest);
    if (stream) { index += stream[0].length; continue; }
    if (char === "\n") {
      if (current().words.length > 0) commands.push({ words: [], fed: false });
      index += 1;
      continue;
    }
    const operator = /^(?:&&|\|\||;|\|)/.exec(rest)?.[0];
    if (operator) {
      // An operator joins two commands. One with nothing before it, or `|&`, `;;`, `&`, is not read.
      if (current().words.length === 0 || /^[|;&]/.test(rest.slice(operator.length))) return null;
      // What comes through a pipe is the next program's input, and some programs run their input.
      commands.push({ words: [], fed: operator === "|" });
      index += operator.length;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, index + 1);
      if (end < 0 || !boundary(end + 1)) return null;
      const value = command.slice(index + 1, end);
      if (!(char === "'" ? SINGLE_QUOTED : DOUBLE_QUOTED).test(value) || value.includes("\n")) return null;
      current().words.push({ value, quoted: true });
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < command.length && PLAIN.test(command[end])) end += 1;
    if (end === index || !boundary(end)) return null;
    const value = command.slice(index, end);
    // A shell expands `~` at the start of a word and after `=` or `:`, and zsh expands a leading `=`.
    if (/(?:^|[=:])~|^=/.test(value)) return null;
    current().words.push({ value, quoted: false });
    index = end;
  }
  // Only `;` or a new line may end a command. `&&`, `||`, and `|` leave the shell waiting for more.
  if (current().words.length === 0) {
    if (/(?:&&|\|\||\|)[ \t\n]*$/.test(command)) return null;
    commands.pop();
  }
  return commands.length > 0 ? commands : null;
}

/** True when the text names nothing outside the project and nothing that holds credentials or history. */
function staysInProject(value, project) {
  // `@file` makes several programs read their arguments from the file.
  if (value.includes("://") || /(?:^|[=:,])@/.test(value) || CREDENTIAL.test(value)) return false;
  for (const piece of value.split(/[=:,]/)) {
    if (piece.startsWith("~")) return false;
    const parts = piece.split("/");
    if (parts.some((part) => part === ".." || part.toLowerCase() === ".git")) return false;
    if (piece.startsWith("/")) {
      const path = piece.replace(/\/+$/, "") || "/";
      if (parts.slice(1, -1).some((part) => part === "" || part === ".")) return false;
      if (path !== project && !path.startsWith(`${project}/`)) return false;
    }
  }
  return true;
}

const NUMBER = /^\d{1,6}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const SOURCE_FILE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/;
const PYTHON_FILE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*\.py$/;

const any = () => true;
const number = (value) => NUMBER.test(value);
const name = (value) => NAME.test(value);
const plainName = (value) => NAME.test(value) && !CONSEQUENTIAL_NAME.test(value);
const unremarkable = (value) => !CONSEQUENTIAL_NAME.test(value);
const letters = (text) => [...text].map((letter) => `-${letter}`);

/**
 * Read one program's arguments against what it is known to take, and return
 * its plain words, or null when anything is not known.
 *
 * `flags` stand alone, and one-letter flags may be written together.
 * `valued` options take the next word, which must pass the given test. A
 * `--long` option may take `=value` instead, and so may a `-long` one when
 * `dashed` is set, as Go writes them. `count` allows `-20` as a number of
 * lines. Options come before the first plain word unless `anywhere` is set.
 */
function readArguments(args, spec, project) {
  const flags = new Set(spec.flags ?? []);
  const valued = spec.valued ?? {};
  const words = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    // `-` is the input, and `--` would hide an option from what follows.
    if (arg === "-" || arg === "--") return null;
    if (!arg.startsWith("-")) {
      if (!staysInProject(arg, project)) return null;
      words.push(arg);
      continue;
    }
    if (words.length > 0 && spec.anywhere !== true) return null;
    if (spec.count === true && NUMBER.test(arg.slice(1))) continue;
    const assigned = (spec.dashed === true ? /^(--?[A-Za-z][A-Za-z0-9-]*)=(.*)$/ : /^(--[A-Za-z][A-Za-z0-9-]*)=(.*)$/).exec(arg);
    // `-n=20` gives most programs the value `=20`, which is not what these rules would read.
    if (!assigned && arg.includes("=")) return null;
    const option = assigned ? assigned[1] : arg;
    if (Object.hasOwn(valued, option)) {
      const value = assigned ? assigned[2] : args[index += 1];
      if (typeof value !== "string" || value === "" || value.startsWith("-")
        || !staysInProject(value, project) || valued[option](value) !== true) return null;
      continue;
    }
    if (assigned) return null;
    if (flags.has(arg)) continue;
    if (/^-[A-Za-z0-9]{2,}$/.test(arg) && [...arg.slice(1)].every((letter) => flags.has(`-${letter}`))) continue;
    return null;
  }
  return words;
}

const reads = (spec) => (args, project) => readArguments(args, spec, project) !== null;

const GIT_LOOK = {
  flags: [
    ...letters("pqswbinlcrtEF"), "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--oneline", "--cached", "--staged",
    "--patch", "--no-patch", "--graph", "--all", "--decorate", "--follow", "--no-color", "--abbrev-commit", "--word-diff", "--reverse",
    "--merges", "--no-merges", "--first-parent", "--short", "--branch", "--porcelain", "--long", "--tags", "--always", "--show-toplevel",
    "--abbrev-ref", "--verify", "--count", "--others", "--modified", "--deleted", "--exclude-standard", "--summary", "--root",
  ],
  // `%G` in a format makes git run gpg on each commit.
  valued: { "-n": number, "-U": number, "--max-count": number, "--abbrev": number, "--format": (value) => !value.includes("%G"),
    "--pretty": (value) => !value.includes("%G"), "--since": any,
    "--until": any, "--author": any, "--grep": any, "--diff-filter": any, "-L": any, "-e": any, "-S": any, "-G": any },
  count: true,
  anywhere: true,
};
/** `git grep` reads `-n` as "show line numbers", where `git log` reads it as a count. */
const GIT_GREP = {
  flags: [...letters("nilcwhIEF"), "--line-number", "--ignore-case", "--files-with-matches", "--count", "--word-regexp", "--fixed-strings",
    "--extended-regexp", "--cached", "--no-color"],
  valued: { "-e": any, "-A": number, "-B": number, "-C": number },
  anywhere: true,
};
const GIT_VERBS = new Set([
  "status", "diff", "log", "show", "blame", "ls-files", "ls-tree", "grep", "rev-parse", "rev-list", "describe", "shortlog", "merge-base",
]);

/**
 * Test runners and checkers take files to check and a few options that change
 * only what is printed. A plain word must look like a path, because these
 * tools read a bare word as a subcommand, or as the value of the flag before it.
 */
const TOOLS = {
  tsc: { flags: ["--noEmit", "--pretty", "--skipLibCheck", "--strict"], valued: { "-p": any, "--project": any }, needs: ["--noEmit"], files: false },
  "vue-tsc": { flags: ["--noEmit", "--pretty", "--skipLibCheck"], valued: { "-p": any, "--project": any }, needs: ["--noEmit"], files: false },
  vitest: { flags: ["--run", "--silent", "--passWithNoTests"], valued: { "--bail": number, "-t": any }, starts: ["run"], needs: ["run", "--run"] },
  jest: { flags: ["--ci", "--runInBand", "-i", "--silent", "--verbose", "--bail", "--passWithNoTests"], valued: { "-t": any } },
  mocha: { flags: ["--bail", "-b", "--exit"], valued: { "-g": any, "--grep": any } },
  ava: { flags: ["--fail-fast", "--serial", "-s", "--verbose", "-v"], valued: { "-m": any, "--match": any } },
  // Without one of these, prettier rewrites the files it is given.
  prettier: { flags: ["--check", "-c", "--list-different", "-l"], needs: ["--check", "-c", "--list-different", "-l"] },
  eslint: { flags: ["--quiet", "--no-color"], valued: { "--max-warnings": number } },
  biome: { flags: [], starts: ["check", "lint"], needs: ["check", "lint"] },
};

/** A word with a `/` or a `.` in it, so not a subcommand and not `true`, `false`, or `null`. */
const looksLikePath = (word) => /[/.]/.test(word) && !/^(?:true|false|null|undefined)$/i.test(word);

function toolAllowed(tool, args, project) {
  const spec = TOOLS[tool];
  const words = readArguments(args, spec, project);
  if (!words || !words.every(unremarkable)) return false;
  if (spec.needs && !spec.needs.some((word) => args.includes(word))) return false;
  const files = spec.starts?.includes(words[0]) ? words.slice(1) : words;
  return spec.files === false ? files.length === 0 : files.every(looksLikePath);
}

const PYTEST = { flags: ["-q", "-v", "-vv", "-x", "-s", "--lf", "--ff", "-ra"],
  valued: { "-k": any, "-m": any, "--maxfail": number, "--tb": (value) => /^(?:auto|long|short|line|native|no)$/.test(value) } };
const pytestAllowed = (args, project) => readArguments(args, PYTEST, project)?.every((word) => unremarkable(word) && looksLikePath(word)) === true;

/** Test files to run, given after `--` or on their own. An option would go to the runner unread. */
function testFiles(args, project) {
  const files = args[0] === "--" ? args.slice(1) : args;
  return files.every((file) => !file.startsWith("-") && looksLikePath(file) && staysInProject(file, project) && unremarkable(file));
}

/** A script and the plain words it is given. An option would go to the script unread. */
function scriptAndWords(words, pattern, project) {
  return typeof words[0] === "string" && pattern.test(words[0])
    && words.every((word) => !word.startsWith("-") && staysInProject(word, project) && unremarkable(word));
}

function nodeAllowed(args, project) {
  if (args.length === 1 && /^(?:--version|-v)$/.test(args[0])) return true;
  let index = 0;
  let testing = false;
  // Only options that carry their own value, so none can take the script's place.
  for (; index < args.length && args[index].startsWith("-"); index += 1) {
    if (args[index] === "--import" && /^tsx(?:\/esm)?$/.test(args[index + 1] ?? "")) index += 1;
    else if (args[index] === "--test") testing = true;
    else if (!/^(?:--import=tsx(?:\/esm)?|--test-concurrency=\d{1,3}|--test-timeout=\d{1,7}|--test-only|--experimental-test-module-mocks|--experimental-strip-types|--no-warnings|--enable-source-maps)$/.test(args[index])) return false;
  }
  const rest = args.slice(index);
  // Without a script, node reads its program from the input, unless it was told to find the tests.
  return rest.length === 0 ? testing : scriptAndWords(rest, SOURCE_FILE, project);
}

function pythonAllowed(args, project) {
  return args[0] === "-m" ? args[1] === "pytest" && pytestAllowed(args.slice(2), project) : scriptAndWords(args, PYTHON_FILE, project);
}

/**
 * Each program these rules can read, and what it may be given. A program that
 * is not listed is not allowed, however harmless it is, and neither is an
 * option that is not listed for it.
 */
const PROGRAMS = {
  ls: reads({ flags: letters("1AaFRSdhlrt") }),
  pwd: (args) => args.length === 0,
  cat: reads({ flags: ["-n", "-b"] }),
  head: reads({ valued: { "-n": number, "-c": number }, count: true }),
  tail: reads({ valued: { "-n": number, "-c": number }, count: true }),
  wc: reads({ flags: letters("lwcm") }),
  stat: reads({}),
  du: reads({ flags: letters("shac"), valued: { "-d": number } }),
  basename: reads({}),
  dirname: reads({}),
  cut: reads({ valued: { "-d": any, "-f": any, "-c": any } }),
  date: (args) => args.every((arg) => /^\+[A-Za-z0-9%:_./ -]*$/.test(arg)),
  echo: (args) => args.every((arg) => !arg.startsWith("-") || /^-[neE]+$/.test(arg)),
  which: reads({}),
  diff: reads({ flags: letters("urqwbBN"), valued: { "-U": number } }),
  // A second file name is where `uniq` writes.
  uniq: (args, project) => (readArguments(args, { flags: letters("cdui") }, project) ?? [0, 0]).length <= 1,
  sort: reads({ flags: letters("bdfgnruV"), valued: { "-k": any, "-t": any } }),
  tree: reads({ flags: ["-a", "-d"], valued: { "-L": number, "-I": any } }),
  // An option after the pattern is read as an option or as a file to read. Either only reads.
  grep: reads({ flags: letters("EFGHIRabchilnoqrsvwx"), count: true, anywhere: true, valued: { "-e": any, "-A": number, "-B": number, "-C": number,
    "-m": number, "--include": any, "--exclude": any, "--exclude-dir": any, "--color": any } }),
  rg: reads({ flags: [...letters("FHINSabchilnosuvwx"), "--files", "--hidden", "--no-ignore", "--no-heading", "--line-number"],
    anywhere: true, valued: { "-e": any, "-g": any, "-t": name, "-T": name, "-A": number, "-B": number, "-C": number, "-m": number } }),
  find: (args, project) => {
    let index = 0;
    while (index < args.length && !args[index].startsWith("-")) index += 1;
    if (!args.slice(0, index).every((path) => staysInProject(path, project))) return false;
    // After the places to look, only tests that choose files. Nothing that acts on them.
    const tests = { "-name": 1, "-iname": 1, "-path": 1, "-ipath": 1, "-type": 1, "-maxdepth": 1, "-mindepth": 1, "-newer": 1, "-mtime": 1,
      "-mmin": 1, "-size": 1, "-not": 0, "-o": 0, "-a": 0, "-print": 0, "-prune": 0, "-empty": 0 };
    while (index < args.length) {
      if (!Object.hasOwn(tests, args[index])) return false;
      const takes = tests[args[index]];
      if (takes === 1 && (args[index + 1] === undefined || !staysInProject(args[index + 1], project))) return false;
      index += 1 + takes;
    }
    return true;
  },
  git: ([verb, ...args], project) => {
    if (verb === "branch") return args.every((arg) => /^(?:--show-current|--list|--all|--remotes|-a|-r|-l|-v|-vv)$/.test(arg));
    if (verb === "tag") return args.every((arg) => /^(?:--list|-l)$/.test(arg));
    // One `--` may separate revisions from paths. What follows it is a path.
    const separator = args.indexOf("--");
    const before = separator < 0 ? args : args.slice(0, separator);
    const paths = separator < 0 ? [] : args.slice(separator + 1);
    return GIT_VERBS.has(verb) && readArguments(before, verb === "grep" ? GIT_GREP : GIT_LOOK, project) !== null
      && paths.every((path) => !path.startsWith("-") && staysInProject(path, project));
  },
  npm: ([verb, ...rest], project) => {
    if (verb === "ls" || verb === "list") return rest.every((arg) => /^(?:--depth=\d+|--all|-a|--json|--long|-l)$/.test(arg));
    // `npm run` runs a script from the project's manifest and nothing else.
    if (verb === "run" || verb === "run-script") return rest.length === 1 && plainName(rest[0]);
    return verb === "test" && testFiles(rest, project);
  },
  pnpm: ([verb, ...rest], project) => verb === "test" && testFiles(rest, project),
  yarn: ([verb, ...rest], project) => verb === "test" && testFiles(rest, project),
  bun: ([verb, ...rest], project) => verb === "test" && testFiles(rest, project),
  // Without one of these, a tool the project lacks is downloaded and run.
  npx: ([first, tool, ...rest], project) => /^(?:--no-install|--no|--offline)$/.test(first ?? "")
    && Object.hasOwn(TOOLS, tool ?? "") && toolAllowed(tool, rest, project),
  ...Object.fromEntries(Object.keys(TOOLS).map((tool) => [tool, (args, project) => toolAllowed(tool, args, project)])),
  pytest: pytestAllowed,
  node: nodeAllowed,
  python: pythonAllowed,
  python3: pythonAllowed,
  go: ([verb, ...args], project) => verb === "version" && args.length === 0
    || (verb === "test" || verb === "vet")
      && readArguments(args, { flags: ["-v", "-race", "-short", "-failfast"], dashed: true,
        valued: { "-run": any, "-count": number, "-timeout": (value) => /^\d{1,4}[smh]$/.test(value) } }, project)
        ?.every((word) => /^[A-Za-z0-9_./-]+$/.test(word) && unremarkable(word)) === true,
  cargo: ([verb, ...args], project) => verb === "fmt" ? args.length === 1 && args[0] === "--check"
    : /^(?:test|check|clippy)$/.test(verb ?? "")
      && readArguments(args, { flags: ["--all", "--workspace", "--all-features", "--all-targets", "--release", "-q", "--quiet", "--lib",
        "--tests", "--locked", "--offline"], valued: { "-p": name, "--package": name } }, project)?.every(plainName) === true,
  // A target only. `-f`, `-C`, and `NAME=value` choose what runs, and `-p` prints the environment.
  make: (args) => args.length > 0 && args.every(plainName),
};

/**
 * Programs that run code. Any of them may run what arrives on its input: an
 * interpreter given no file, or a project script that is only an interpreter.
 */
const RUNS_CODE = new Set([
  "node", "python", "python3", "npm", "pnpm", "yarn", "bun", "npx", "make", "pytest", "go", "cargo", ...Object.keys(TOOLS),
]);

function simpleCommandAllowed({ words, fed }, project) {
  const [program, ...rest] = words;
  // The program is named in plain lower case: no path, no quotes, no assignment before it.
  if (program.quoted || !Object.hasOwn(PROGRAMS, program.value)) return false;
  if (fed && RUNS_CODE.has(program.value)) return false;
  return PROGRAMS[program.value](rest.map((word) => word.value), project) === true;
}

/**
 * True when a person must decide. It means only that these rules cannot read
 * the command, not that the command is harmful.
 */
export function commandNeedsPerson(command, project) {
  try {
    if (!isText(command, PERMISSION_REVIEW_MAX_COMMAND_CHARS)) return true;
    const root = normalizedProject(project);
    if (!root) return true;
    const commands = readCommands(command);
    return !commands || !commands.every((simple) => simpleCommandAllowed(simple, root));
  } catch {
    return true;
  }
}

const KINDS = ["read", "check", "edit", "risky"];

const QUESTIONS = {
  kind: {
    type: "choice",
    instructions: "What is the most consequential thing `commands` does?",
    criteria: {
      read: "Only reads, lists, or searches files or version history. Changes nothing.",
      check: "Runs the project's own tests, type checker, linter, or build.",
      edit: "Creates, changes, moves, or stages files inside `project`.",
      risky: "Deletes or empties files, runs a script whose effect cannot be told from its name, affects anything outside `project`, contacts a network service, or handles money, customers, production, or credentials.",
    },
  },
};

/**
 * Build the state and question for one pending request, or null when the
 * rules already require a person.
 */
export function buildPermissionReviewRequest(input) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const project = normalizedProject(input.project);
    if (!project || !Array.isArray(input.commands)) return null;
    // Copy once, then judge the copy: what is checked is what is sent.
    const commands = Array.from(input.commands);
    if (commands.length === 0 || commands.length > PERMISSION_REVIEW_MAX_COMMANDS
      || commands.some((command) => commandNeedsPerson(command, project))) return null;
    return { state: { commands, project }, questions: structuredClone(QUESTIONS) };
  } catch {
    return null;
  }
}

function own(value, key) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function probability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function wholeKinds(kinds) {
  if (!kinds || typeof kinds !== "object" || Array.isArray(kinds)) return null;
  const scores = {};
  let total = 0;
  for (const kind of KINDS) {
    const value = probability(own(kinds, kind));
    if (value === null) return null;
    scores[kind] = value;
    total += value;
  }
  // A kind this file does not know, or scores that are not a whole, is not an answer.
  return Reflect.ownKeys(kinds).every((kind) => KINDS.includes(kind)) && Math.abs(total - 1) <= KIND_TOTAL_TOLERANCE ? scores : null;
}

/** Read the answer. The kind the model picked must be the kind it scored highest. */
export function parsePermissionReviewAnswers(body) {
  try {
    const kind = own(own(body, "answers"), "kind");
    const kinds = wholeKinds(own(kind, "probabilities"));
    const choice = own(kind, "choice");
    return { kinds: kinds && KINDS.includes(choice) && KINDS.every((other) => kinds[other] <= kinds[choice]) ? kinds : null };
  } catch {
    return { kinds: null };
  }
}

/**
 * "allow" only for a confident reading or checking command. Anything else,
 * including a command that changes files and a missing answer, is "ask".
 */
export function decidePermissionReview(answers) {
  try {
    const kinds = wholeKinds(own(answers, "kinds"));
    return kinds !== null && kinds.read + kinds.check >= PERMISSION_REVIEW_APPROVE_AT
      && kinds.risky <= PERMISSION_REVIEW_RISKY_AT_MOST ? "allow" : "ask";
  } catch {
    return "ask";
  }
}

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

/** The text inside a quote that starts at `index`, and where the quote ends, or null. */
function quotedText(command, index) {
  const quote = command[index];
  const end = command.indexOf(quote, index + 1);
  if (end < 0) return null;
  const value = command.slice(index + 1, end);
  return (quote === "'" ? SINGLE_QUOTED : DOUBLE_QUOTED).test(value) && !value.includes("\n") ? { value, end: end + 1 } : null;
}

/**
 * Split a command into simple commands of words, or return null when any part
 * of it is written in a way these rules do not read: expansion, substitution,
 * escaping, grouping, a redirect to a file, a background job, a comment, or a
 * quote joined to other text other than an option's value.
 *
 * Each simple command also says how it is joined to the one before it, and
 * where it is in the text, so a part of the command can be judged as written.
 */
function readCommands(command) {
  // Printable ASCII, tab, and new line only. Anything else can look like a space and not be one.
  if (!/^[\x20-\x7e\t\n]+$/.test(command)) return null;
  const commands = [{ words: [], fed: false, joiner: null, start: -1, end: -1 }];
  const current = () => commands[commands.length - 1];
  const boundary = (index) => index >= command.length || " \t\n;|&".includes(command[index]);
  const covers = (from, to) => { if (current().start < 0) current().start = from; current().end = to; };
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === " " || char === "\t") { index += 1; continue; }
    const rest = command.slice(index);
    const stream = STREAM.exec(rest);
    if (stream) { covers(index, index + stream[0].length); index += stream[0].length; continue; }
    if (char === "\n") {
      if (current().words.length > 0) commands.push({ words: [], fed: false, joiner: "\n", start: -1, end: -1 });
      else current().start = -1;
      index += 1;
      continue;
    }
    const operator = /^(?:&&|\|\||;|\|)/.exec(rest)?.[0];
    if (operator) {
      // An operator joins two commands. One with nothing before it, or `|&`, `;;`, `&`, is not read.
      if (current().words.length === 0 || /^[|;&]/.test(rest.slice(operator.length))) return null;
      // What comes through a pipe is the next program's input, and some programs run their input.
      commands.push({ words: [], fed: operator === "|", joiner: operator, start: -1, end: -1 });
      index += operator.length;
      continue;
    }
    if (char === "'" || char === '"') {
      const quoted = quotedText(command, index);
      if (!quoted || !boundary(quoted.end)) return null;
      current().words.push({ value: quoted.value, quoted: true });
      covers(index, quoted.end);
      index = quoted.end;
      continue;
    }
    let end = index;
    while (end < command.length && PLAIN.test(command[end])) end += 1;
    if (end === index) return null;
    let value = command.slice(index, end);
    // A shell expands `~` at the start of a word and after `=` or `:`, and zsh expands a leading `=`.
    if (/(?:^|[=:])~|^=/.test(value)) return null;
    // `--format='%an <%ae>'` is one word to a shell: an option, `=`, and a value quoted whole.
    if (value.endsWith("=") && (command[end] === "'" || command[end] === '"')) {
      const quoted = quotedText(command, end);
      if (!quoted) return null;
      value += quoted.value;
      end = quoted.end;
    }
    if (!boundary(end)) return null;
    current().words.push({ value, quoted: false });
    covers(index, end);
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
    // `--check` only parses the script. It never runs it.
    else if (!/^(?:--import=tsx(?:\/esm)?|--test-concurrency=\d{1,3}|--test-timeout=\d{1,7}|--test-only|--experimental-test-module-mocks|--experimental-strip-types|--no-warnings|--enable-source-maps|--check|-c)$/.test(args[index])) return false;
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
  // No echo reads `---` as an option, so a separator such as `---files---` is printed as written.
  echo: (args) => args.every((arg) => !arg.startsWith("-") || /^-[neE]+$/.test(arg) || arg.startsWith("---")),
  which: reads({}),
  diff: reads({ flags: letters("urqwbBN"), valued: { "-U": number } }),
  // Printing a range of lines only. Any other script can write a file or run a command.
  sed: ([quiet, script, ...files], project) => quiet === "-n" && /^(?:\d{1,7}|\$)(?:,(?:\d{1,7}|\$))?p$/.test(script ?? "")
    && readArguments(files, {}, project) !== null,
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
    // `-C` naming the project itself runs Git where it runs anyway. Any other folder may be another repository, with hooks of its own.
    if (verb === "-C") return args[0]?.replace(/\/+$/, "") === project && PROGRAMS.git(args.slice(1), project);
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

/**
 * A branch or commit named in plain words. `FETCH_HEAD` is whatever was
 * fetched last, which may be anyone's pull request.
 */
function isRef(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) && !/\.\.|\/\/|\/\.|\.lock(?:\/|$)|[/.]$/.test(value)
    && value !== "FETCH_HEAD";
}

/** A jq filter that cannot read the environment, a file, or another input. */
const jqFilter = (value) => !/\$|\b(?:env|input|inputs|input_filename|import|include|debug|stderr|halt|halt_error|get_search_list)\b/.test(value);
const GH_OUTPUT = { "--json": (value) => /^[A-Za-z]+(?:,[A-Za-z]+)*$/.test(value), "--jq": jqFilter, "-q": jqFilter };
const ghState = (value) => /^(?:open|closed|merged|all)$/.test(value);
const ghLogin = (value) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
// `gh` quotes a label. It puts search text inside parentheses that the text can close, so a search may reach any repository.
const ghLabel = (value) => /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,49}$/.test(value);
const GH_LIST = { ...GH_OUTPUT, "--state": ghState, "-s": ghState, "--limit": number, "-L": number, "--label": ghLabel, "-l": ghLabel,
  "--author": ghLogin, "-A": ghLogin, "--assignee": ghLogin, "-a": ghLogin };
const pullRequest = (value) => NUMBER.test(value) || isRef(value);

/**
 * `gh` commands that only read this repository's pull requests and issues.
 * There is no `--repo`, so `gh` reads the repository the project's remote
 * names, and no `--web`, which opens a browser.
 */
const GH_READS = {
  pr: {
    view: { spec: { flags: ["--comments", "-c"], valued: GH_OUTPUT, anywhere: true }, most: 1, target: pullRequest },
    diff: { spec: { flags: ["--name-only", "--patch"], anywhere: true }, most: 1, target: pullRequest },
    checks: { spec: { flags: ["--required"], valued: GH_OUTPUT, anywhere: true }, most: 1, target: pullRequest },
    status: { spec: { valued: GH_OUTPUT, anywhere: true }, most: 0 },
    list: { spec: { valued: { ...GH_LIST, "--head": isRef, "-H": isRef, "--base": isRef, "-B": isRef }, anywhere: true }, most: 0 },
  },
  issue: {
    view: { spec: { flags: ["--comments", "-c"], valued: GH_OUTPUT, anywhere: true }, least: 1, most: 1, target: number },
    list: { spec: { valued: GH_LIST, anywhere: true }, most: 0 },
  },
};

function githubRead([noun, verb, ...args], project) {
  const read = Object.hasOwn(GH_READS, noun ?? "") && Object.hasOwn(GH_READS[noun], verb ?? "") ? GH_READS[noun][verb] : null;
  const words = read ? readArguments(args, read.spec, project) : null;
  return words !== null && words.length >= (read.least ?? 0) && words.length <= read.most && words.every((word) => read.target(word));
}

/** A message given on the command line. Git opens an editor for one that is not. */
const message = (value) => typeof value === "string" && value.length > 0 && !value.startsWith("-");

/**
 * Git commands that stage named files, commit, merge, fetch branches from
 * `origin`, switch branches, or push to `origin`. Returns what the caller must
 * still check: the branch the command creates or switches to and the branch
 * it pushes to, which must be the agent's own, and the commit it merges or
 * starts a branch from, which brings that commit's files into the project.
 * Null when the command is not one of these.
 */
function gitWork([verb, ...rest], project) {
  if (verb === "add") {
    const files = readArguments(rest, { flags: ["-u", "--update", "-v", "--verbose"], anywhere: true }, project);
    // Files by name. A folder, a pattern, or a name that starts with a dot may hold more than the agent wrote.
    return files?.every((file) => /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+$/.test(file)
      && file.split("/").every((part) => part !== "" && !part.startsWith("."))) ? {} : null;
  }
  if (verb === "commit") {
    let given = false;
    const options = [];
    for (let at = 0; at < rest.length; at += 1) {
      if (rest[at] !== "-m" && rest[at] !== "--message") options.push(rest[at]);
      else if (message(rest[at + 1])) { given = true; at += 1; } else return null;
    }
    if (!options.every((option) => /^(?:-q|--quiet|-a|--all|--amend|--no-edit|--reset-author|-s|--signoff)$/.test(option))) return null;
    return given || (options.includes("--amend") && options.includes("--no-edit")) ? {} : null;
  }
  if (verb === "checkout" || verb === "switch") {
    const words = rest.filter((word) => word !== "-q" && word !== "--quiet");
    // A new branch, from a named commit or from where the agent is now.
    if (words[0] === (verb === "checkout" ? "-b" : "-c") && words.length >= 2 && words.length <= 3 && words.slice(1).every(isRef)) {
      return { branch: words[1], ...(words[2] === undefined ? {} : { from: words[2] }) };
    }
    // An existing branch. `git checkout <name>` restores a file or folder of that name when no branch has it, so only `git switch`.
    return verb === "switch" && words.length === 1 && isRef(words[0]) ? { branch: words[0] } : null;
  }
  if (verb === "merge") {
    const words = [];
    for (let at = 0; at < rest.length; at += 1) {
      if (rest[at] === "-m") { if (!message(rest[at + 1])) return null; at += 1; }
      else if (!/^(?:-q|--quiet|--no-edit|--ff|--ff-only|--no-ff|--no-stat)$/.test(rest[at])) words.push(rest[at]);
    }
    return words.length === 1 && isRef(words[0]) ? { from: words[0] } : null;
  }
  if (verb === "fetch") {
    const words = readArguments(rest, { flags: ["-q", "--quiet", "--prune", "-p"], anywhere: true }, project);
    // Branches of `origin` only. A pull request's ref may hold anyone's code.
    return words?.[0] === "origin" && words.slice(1).every((ref) => isRef(ref) && !/^(?:pull|refs)\//.test(ref)) ? {} : null;
  }
  if (verb === "push") {
    // No force, no deletion, and no tags. The branch it goes to is named after `:`, so neither the branch checked
    // out, nor its upstream, nor any push setting decides where it goes.
    const words = readArguments(rest, { flags: ["-u", "--set-upstream", "-q", "--quiet"], anywhere: true }, project);
    if (words?.length !== 2 || words[0] !== "origin") return null;
    const [source, destination, extra] = words[1].split(":");
    return extra === undefined && destination !== undefined && isRef(source) && isRef(destination)
      ? { push: destination.startsWith("refs/heads/") ? destination.slice("refs/heads/".length) : destination } : null;
  }
  return null;
}

/**
 * True when each simple command in each part is, word for word, one in the
 * whole command. A part another parser found that these rules did not is a
 * reading of the command they have not judged.
 */
export function partsAreInCommand(command, parts) {
  try {
    if (!isText(command, PERMISSION_REVIEW_MAX_COMMAND_CHARS) || !Array.isArray(parts)) return false;
    const key = (simple) => JSON.stringify(simple.words.map((word) => [word.value, word.quoted && simple.words[0] === word]));
    const whole = new Set((readCommands(command) ?? []).map(key));
    return whole.size > 0 && parts.every((part) => {
      const simples = isText(part, PERMISSION_REVIEW_MAX_COMMAND_CHARS) ? readCommands(part) : null;
      return simples !== null && simples.every((simple) => whole.has(key(simple)));
    });
  } catch {
    return false;
  }
}

/**
 * True when every part of the command only reads: files inside the project,
 * the repository's history, or its pull requests and issues. Nothing that
 * runs the project's own code, which may write anything.
 */
export function commandOnlyReads(command, project) {
  try {
    if (!isText(command, PERMISSION_REVIEW_MAX_COMMAND_CHARS)) return false;
    const root = normalizedProject(project);
    const commands = root ? readCommands(command) : null;
    return commands !== null && commands.every((simple) => (simpleCommandAllowed(simple, root) && !RUNS_CODE.has(simple.words[0].value))
      || (!simple.words[0].quoted && simple.words[0].value === "gh" && githubRead(simple.words.slice(1).map((word) => word.value), root)));
  } catch {
    return false;
  }
}

/**
 * Review a command from an agent that works on its own branches, as far as
 * these rules can. Returns null when a person must decide. Otherwise returns
 * the parts Jev must still review, each as written: none when the rules alone
 * allow the whole command.
 *
 * The rules allow on their own what Jev would call a change or a network call
 * but is routine for such an agent: reading this repository's pull requests
 * and issues, and staging, committing, fetching from `origin`, merging
 * `origin`'s default branch or its own, and creating, switching to, and
 * pushing to its own branches. Reading and the project's checks still go to Jev, as written.
 *
 * `ownBranch` says whether a branch is the agent's own. `defaultBranch` is the
 * branch `origin` names as its default, or null when it is not known. A merge
 * or a new branch may start only from `origin`'s copy of that branch, the
 * agent's own, or where it is: any other branch, the local default branch
 * included, may bring in settings and hooks that no one reviewed.
 */
export function routineCommandReview(command, project, context) {
  try {
    if (!isText(command, PERMISSION_REVIEW_MAX_COMMAND_CHARS)) return null;
    const root = normalizedProject(project);
    const commands = root ? readCommands(command) : null;
    if (!commands) return null;
    const own = (branch) => typeof branch === "string" && context.ownBranch(branch) === true;
    const base = typeof context.defaultBranch === "string" && isRef(context.defaultBranch) ? context.defaultBranch : null;
    const trusted = (ref) => ref === "HEAD" || own(ref) || (ref.startsWith("origin/") && own(ref.slice("origin/".length)))
      || (base !== null && ref === `origin/${base}`);
    const review = [];
    let decided = false;
    for (const simple of commands) {
      if (simpleCommandAllowed(simple, root)) {
        review.push(command.slice(simple.start, simple.end));
        continue;
      }
      decided = true;
      const [program, ...words] = simple.words;
      const args = words.map((word) => word.value);
      if (!program.quoted && program.value === "gh" && githubRead(args, root)) continue;
      const work = !program.quoted && program.value === "git" ? gitWork(args, root) : null;
      if (!work || (work.branch !== undefined && !own(work.branch)) || (work.push !== undefined && !own(work.push))
        || (work.from !== undefined && !trusted(work.from))) return null;
    }
    // A command the rules decided no part of is reviewed whole, as it always was.
    if (!decided) return [command];
    return review.length <= PERMISSION_REVIEW_MAX_COMMANDS ? review : null;
  } catch {
    return null;
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

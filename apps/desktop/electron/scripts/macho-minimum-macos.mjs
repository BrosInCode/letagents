// The oldest macOS each Mach-O file of the bundle starts on.
//
// The app's Info.plist declares LSMinimumSystemVersion (Electron's 12.0), and
// macOS installs and updates the app on any system that meets it. A file in the
// bundle that was linked for a newer macOS (LC_BUILD_VERSION minos) does not
// load there: dyld stops it at launch, and the user sees no reason. So the
// packager reads every Mach-O header and fails the build when a file needs a
// newer macOS than the app declares, unless the file is on the exceptions list
// with the feature it belongs to and the minimum that feature checks at run
// time. The JS reader has no Xcode dependency, so it works on every release
// runner, and it reads only the headers, never whole files.
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;
// Images that dyld loads: each must name the macOS it needs.
const LOADED_FILE_TYPES = new Map([[0x2, "executable"], [0x6, "dynamic library"], [0x8, "bundle"]]);
// Java class files also start with 0xcafebabe; their next word is a class file
// version (45 and up), which no universal binary has as its slice count.
const MAX_FAT_SLICES = 32;
const MAX_LOAD_COMMAND_BYTES = 16 * 1024 * 1024;

/** "X.Y" or "X.Y.Z" from a Mach-O nibble-packed xxxx.yy.zz version. */
export function formatMachOVersion(packed) {
  const major = packed >>> 16;
  const minor = (packed >>> 8) & 0xff;
  const patch = packed & 0xff;
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

/** Negative, zero or positive, as a is older than, equal to or newer than b ("13.0" equals "13"). */
export function compareMacOSVersions(a, b) {
  const left = parseMacOSVersion(a);
  const right = parseMacOSVersion(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function parseMacOSVersion(value) {
  if (typeof value !== "string" || !/^\d+(\.\d+){0,2}$/.test(value)) {
    throw new Error(`'${value}' is not a macOS version.`);
  }
  return value.split(".").map(Number);
}

function isThinMagic(buffer) {
  if (buffer.length < 4) return false;
  return [buffer.readUInt32LE(0), buffer.readUInt32BE(0)].some((magic) => magic === MH_MAGIC || magic === MH_MAGIC_64);
}

/**
 * The macOS minos of one thin Mach-O image at `offset`, or null when it has no
 * macOS build version and is not an image that dyld loads. An image whose
 * header promises more bytes than the file has fails: a cut-off file must not
 * pass as "no minimum". `readAt(offset, length)` returns at most `length` bytes.
 */
async function thinMinimumMacOS(readAt, offset) {
  const header = await readAt(offset, 32);
  if (!isThinMagic(header)) throw new Error(`No Mach-O image at offset ${offset}.`);
  const little = header.readUInt32LE(0) === MH_MAGIC || header.readUInt32LE(0) === MH_MAGIC_64;
  const word = (buffer, at) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const headerSize = word(header, 0) === MH_MAGIC_64 ? 32 : 28;
  if (header.length < headerSize) throw new Error("The Mach-O header is truncated.");
  const fileType = word(header, 12);
  const commandCount = word(header, 16);
  const commandBytes = word(header, 20);
  if (commandBytes > MAX_LOAD_COMMAND_BYTES) throw new Error("Mach-O load commands are too large.");
  const commands = await readAt(offset + headerSize, commandBytes);
  if (commands.length < commandBytes) {
    throw new Error(`The Mach-O load commands are truncated: ${commands.length} of ${commandBytes} bytes.`);
  }
  let minimum = null;
  let cursor = 0;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commands.length) throw new Error("The Mach-O load commands end before their count.");
    const command = word(commands, cursor);
    const size = word(commands, cursor + 4);
    if (size < 8 || cursor + size > commands.length) throw new Error("Mach-O load command is malformed.");
    let version = null;
    if (command === LC_BUILD_VERSION && size >= 16 && word(commands, cursor + 8) === PLATFORM_MACOS) {
      version = formatMachOVersion(word(commands, cursor + 12));
    } else if (command === LC_VERSION_MIN_MACOSX && size >= 12) {
      version = formatMachOVersion(word(commands, cursor + 8));
    }
    if (version && (!minimum || compareMacOSVersions(version, minimum) > 0)) minimum = version;
    cursor += size;
  }
  if (!minimum && LOADED_FILE_TYPES.has(fileType)) {
    throw new Error(`The Mach-O ${LOADED_FILE_TYPES.get(fileType)} names no macOS minimum (no LC_BUILD_VERSION for macOS and no LC_VERSION_MIN_MACOSX).`);
  }
  return minimum;
}

/**
 * The newest macOS minos of any slice, or null when the bytes are not a Mach-O
 * file or no slice names a macOS minimum. A Mach-O file that is cut off fails.
 */
export async function machOMinimumMacOS(readAt) {
  const start = await readAt(0, 8);
  if (start.length < 4) return null;
  const magic = start.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return isThinMagic(start) ? thinMinimumMacOS(readAt, 0) : null;
  if (start.length < 8) throw new Error("The universal Mach-O header is truncated.");
  const sliceCount = start.readUInt32BE(4);
  if (sliceCount === 0 || sliceCount > MAX_FAT_SLICES) return null;
  const entrySize = magic === FAT_MAGIC_64 ? 32 : 20;
  const table = await readAt(8, sliceCount * entrySize);
  if (table.length < sliceCount * entrySize) {
    throw new Error(`The universal Mach-O slice table is truncated: ${table.length} of ${sliceCount * entrySize} bytes.`);
  }
  let minimum = null;
  for (let index = 0; index < sliceCount; index += 1) {
    const at = index * entrySize;
    const offset = magic === FAT_MAGIC_64 ? Number(table.readBigUInt64BE(at + 8)) : table.readUInt32BE(at + 8);
    const version = await thinMinimumMacOS(readAt, offset);
    if (version && (!minimum || compareMacOSVersions(version, minimum) > 0)) minimum = version;
  }
  return minimum;
}

/** machOMinimumMacOS over a Buffer (tests and small files). */
export function bufferReader(buffer) {
  return async (offset, length) => buffer.subarray(offset, offset + length);
}

/** machOMinimumMacOS of a file on disk. */
export async function fileMinimumMacOS(path) {
  const handle = await open(path, "r");
  try {
    return await machOMinimumMacOS(async (offset, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    });
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await handle.close();
  }
}

async function* regularFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // Symbolic links (the framework's Versions/Current) name files that the
    // walk reaches by their real path.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* regularFiles(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * Every Mach-O file under `bundle` that needs a newer macOS than `declared`,
 * as { path, minimum } with `path` relative to the bundle and "/"-separated.
 */
export async function bundleFilesAboveMacOS(bundle, declared, readMinimum = fileMinimumMacOS) {
  const paths = [];
  for await (const path of regularFiles(bundle)) paths.push(path);
  const above = [];
  // A bundle has some 24,000 files; a few reads at a time keep the walk short.
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next];
      next += 1;
      const minimum = await readMinimum(path);
      if (minimum && compareMacOSVersions(minimum, declared) > 0) {
        above.push({ path: relative(bundle, path).split(sep).join("/"), minimum });
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return above.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Fails unless every file that needs a newer macOS than the app declares is an
 * exception, and each exception's file needs exactly the macOS recorded for it.
 * The app turns the feature off below that recorded minimum, so a higher real
 * value would let the feature start where it cannot run, and a lower one would
 * turn it off where it can.
 *
 * `exceptions`: [{ path, feature, minimum }], `path` relative to the bundle.
 */
export async function assertBundleMinimumMacOS({ bundle, declared, exceptions, readMinimum = fileMinimumMacOS }) {
  compareMacOSVersions(declared, declared);
  const problems = [];
  const excepted = new Map(exceptions.map((exception) => [exception.path, exception]));
  for (const exception of exceptions) {
    const absolute = join(bundle, ...exception.path.split("/"));
    const info = await lstat(absolute).catch(() => null);
    const minimum = info?.isFile() ? await readMinimum(absolute) : null;
    if (!minimum) {
      problems.push(`${exception.path} (${exception.feature}) is on the macOS exceptions list, but the bundle has no Mach-O file there.`);
    } else if (compareMacOSVersions(minimum, exception.minimum) !== 0) {
      problems.push(`${exception.path} (${exception.feature}) needs macOS ${minimum}, but its recorded minimum is ${exception.minimum}. Update the recorded minimum and the app's check for ${exception.feature}.`);
    }
  }
  for (const file of await bundleFilesAboveMacOS(bundle, declared, readMinimum)) {
    if (excepted.has(file.path)) continue;
    problems.push(`${file.path} needs macOS ${file.minimum}, but the app declares LSMinimumSystemVersion ${declared}. Rebuild it for macOS ${declared}, or add it to the exceptions list with the feature that checks the macOS version at run time.`);
  }
  if (problems.length) throw new Error(`The bundle's macOS minimum check failed:\n- ${problems.join("\n- ")}`);
}

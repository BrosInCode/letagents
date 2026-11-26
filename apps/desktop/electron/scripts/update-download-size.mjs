import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

// What a differential update downloads, measured with the updater's own
// download planner: the bytes of the new update ZIP whose blocks the
// previous release's blockmap does not have. The release workflow runs it
// against the published feed, so a change that makes every update download
// unchanged files (for example, archive timestamps) shows up in the run.
//
//   node update-download-size.mjs --feed <latest-mac.yml URL> --blockmap <new .zip.blockmap>
//   node update-download-size.mjs --previous-blockmap <URL or path> --blockmap <new .zip.blockmap>

const require = createRequire(import.meta.url);

/** The bytes the updater downloads, and the whole file's size, for an update from `previous` to `next` (parsed blockmaps). */
export function plannedUpdateDownload(previous, next) {
  const { computeOperations, OperationKind } = require("electron-updater/out/differentialDownloader/downloadPlanBuilder");
  const operations = computeOperations(previous, next, { info() {}, warn() {}, debug: null });
  const download = operations
    .filter((operation) => operation.kind === OperationKind.DOWNLOAD)
    .reduce((total, operation) => total + (operation.end - operation.start), 0);
  const total = next.files[0].sizes.reduce((sum, size) => sum + size, 0);
  return { downloadBytes: download, totalBytes: total, reusedBytes: total - download };
}

/**
 * The previous update's blockmap URL from an electron-updater feed
 * (latest-mac.yml, which the release writes as JSON, a subset of YAML): its
 * first file's URL plus ".blockmap".
 */
export function previousBlockmapUrl(feedText, feedUrl) {
  let version;
  let file;
  if (feedText.trimStart().startsWith("{")) {
    const feed = JSON.parse(feedText);
    version = feed.version;
    file = feed.files?.[0]?.url;
  } else {
    version = /^version:\s*['"]?([^'"\s]+)/m.exec(feedText)?.[1];
    file = /^\s*-\s*url:\s*['"]?([^'"\s]+)/m.exec(feedText)?.[1];
  }
  if (!version || !file) throw new Error(`The feed at ${feedUrl} has no version or file URL.`);
  return { version, url: new URL(`${file}.blockmap`, feedUrl).href };
}

async function readSource(source) {
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source} answered ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(source);
}

const parseBlockmap = (bytes) => JSON.parse(gunzipSync(bytes).toString("utf8"));
const megabytes = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;

async function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const blockmap = option("--blockmap");
  const feed = option("--feed");
  let previous = option("--previous-blockmap");
  let previousVersion = "the previous release";
  if (!blockmap || (!feed && !previous)) {
    throw new Error("Usage: update-download-size.mjs --blockmap <path> (--feed <URL> | --previous-blockmap <URL or path>)");
  }
  if (!previous) {
    const found = previousBlockmapUrl((await readSource(feed)).toString("utf8"), feed);
    previous = found.url;
    previousVersion = found.version;
  }
  const result = plannedUpdateDownload(parseBlockmap(await readSource(previous)), parseBlockmap(await readFile(blockmap)));
  const share = result.totalBytes === 0 ? 0 : result.downloadBytes / result.totalBytes;
  const line = `An update from ${previousVersion} downloads ${megabytes(result.downloadBytes)} of the ${megabytes(result.totalBytes)} update ZIP (${(share * 100).toFixed(1)}%).`;
  console.log(JSON.stringify({ previous, ...result }, null, 2));
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}

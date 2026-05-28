import { CORE_ENDPOINTS, parseLanguageServerProcesses, workspaceIdFromUri } from "./language-server.mjs";
import { findLsBaseUrl, unary } from "./connect-rpc.mjs";
import { parseTrajectorySummaries, pickActiveCascadeIdFromMap } from "./cascade-parsing.mjs";

/**
 * Rank LS processes (workspace matching URI first), probe each until we find `wantCascadeId`
 * in summaries or, if `wantCascadeId` is null, pick an active cascade on that instance.
 * @param {{ wantCascadeId: string | null, workspaceUri: string | null, log: (...a: unknown[]) => void }} opt
 * @returns {Promise<{ baseUrl: string, csrf: string, pid: string, kind: "workspace"|"core", cascadeId: string } | null>}
 */
export async function resolveCascadeAcrossLsInstances(opt) {
  const { wantCascadeId, workspaceUri, log } = opt;
  const wantWsId = workspaceUri ? workspaceIdFromUri(workspaceUri) : null;
  const processes = parseLanguageServerProcesses().filter(
    (p) => p.csrf && CORE_ENDPOINTS.some((e) => p.cmd.includes(e)),
  );
  const ranked = processes
    .map((p) => {
      let score = 0;
      if (p.isWorkspaceLsp && wantWsId && p.workspaceId === wantWsId) {
        score += 100;
      } else if (p.isWorkspaceLsp) {
        score += 50;
      } else {
        score += 1;
      }
      return { p, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const { p } of ranked) {
    let baseUrl;
    try {
      baseUrl = await findLsBaseUrl(p.pid, p.csrf, log);
    } catch (e) {
      log(
        `scan-all-ls: skip pid=${p.pid} (${e instanceof Error ? e.message : String(e)})`,
      );
      continue;
    }
    const tr = await unary(baseUrl, p.csrf, "GetAllCascadeTrajectories", {});
    if (tr.status !== 200 || tr.parsed == null) {
      log(`scan-all-ls: GetAllCascadeTrajectories pid=${p.pid} HTTP ${tr.status}`);
      continue;
    }
    const map = parseTrajectorySummaries(tr.parsed);
    if (wantCascadeId) {
      if (map.has(wantCascadeId)) {
        return {
          baseUrl,
          csrf: /** @type {string} */ (p.csrf),
          pid: p.pid,
          kind: p.isWorkspaceLsp ? "workspace" : "core",
          cascadeId: wantCascadeId,
        };
      }
      continue;
    }
    const picked = pickActiveCascadeIdFromMap(map);
    if (picked) {
      return {
        baseUrl,
        csrf: /** @type {string} */ (p.csrf),
        pid: p.pid,
        kind: p.isWorkspaceLsp ? "workspace" : "core",
        cascadeId: picked,
      };
    }
  }
  return null;
}

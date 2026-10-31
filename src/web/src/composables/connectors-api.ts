import type { ConnectorsApi } from "../../../../shared/ui/connectors/types";
import { CONNECTORS_NOT_CONFIGURED_CODE } from "../../../../shared/ticket-connectors.mjs";
type Request = (path: string, options?: RequestInit) => Promise<any>;
/** Same account endpoints as desktop; browser OAuth needs a desktop loopback, so it is intentionally absent. */
export function createConnectorsApi(request: Request): ConnectorsApi {
  const json = (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
  });
  const connection = (id: string) =>
    `/account/connectors/${encodeURIComponent(id)}`;
  const rule = (id: string, ruleId?: string) =>
    `${connection(id)}/rules${ruleId ? `/${encodeURIComponent(ruleId)}` : ""}`;
  return {
    trackers: {
      async list() {
        try {
          return await request("/account/connectors");
        } catch (error) {
          const detail = error as { status?: number; code?: string };
          if (
            detail.status !== 503 ||
            detail.code !== CONNECTORS_NOT_CONFIGURED_CODE
          )
            throw error;
          const off = { oauth: false, api_token: false };
          return {
            connections: [],
            providers: {
              jira: off,
              linear: off,
              github: { ...off, github_app: false },
            },
            jev_linking_disclosure: "",
            not_configured: true,
          };
        }
      },
      saveApiToken: async (input) =>
        (await request("/account/connectors/api-token", json("POST", input)))
          .connection,
      connectGitHub: async (repository) =>
        (
          await request(
            "/account/connectors/github-app",
            json("POST", { repository }),
          )
        ).connection,
      test: (id) => request(`${connection(id)}/test`, { method: "POST" }),
      update: async (id, patch) =>
        (await request(connection(id), json("PATCH", patch))).connection,
      remove: async (id) => {
        await request(connection(id), { method: "DELETE" });
      },
      webhook: (id) => request(`${connection(id)}/webhook`),
      rules: {
        list: (id) => request(rule(id)),
        create: async (id, input) =>
          (await request(rule(id), json("POST", input))).rule,
        update: async (id, ruleId, input) =>
          (await request(rule(id, ruleId), json("PUT", input))).rule,
        setEnabled: async (id, ruleId, enabled) =>
          (
            await request(
              `${rule(id, ruleId)}/enabled`,
              json("POST", { enabled }),
            )
          ).rule,
        versions: async (id, ruleId) =>
          (await request(`${rule(id, ruleId)}/versions`)).versions,
        rollback: async (id, ruleId, version) =>
          (
            await request(
              `${rule(id, ruleId)}/rollback`,
              json("POST", { version }),
            )
          ).rule,
        remove: async (id, ruleId) => {
          await request(rule(id, ruleId), { method: "DELETE" });
        },
        draft: (id, sentence) =>
          request(`${rule(id)}/draft`, json("POST", { sentence })),
      },
    },
    remote: {
      list: () => request("/account/mcp-connections"),
      disconnect: async (id) => {
        await request(`/account/mcp-connections/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      },
    },
  };
}

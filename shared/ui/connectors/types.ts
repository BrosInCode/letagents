import type {
  TrackerApiTokenInput,
  TrackerConnectionList,
  TrackerConnectionPatch,
  TrackerConnectionTestResult,
  TrackerConnectionView,
  TrackerProvider,
  TrackerRuleDraftResult,
  TrackerRuleInput,
  TrackerRuleList,
  TrackerRuleVersionView,
  TrackerRuleView,
  TrackerWebhookSetup,
} from "../../ticket-connectors.mjs";
import type { DesktopMcpInstallTarget } from "../../../apps/desktop/electron/ipc-types/setup";
/** UI transport contract; each host supplies its existing authenticated account API. */
export interface TrackerApi {
  list(): Promise<TrackerConnectionList & { not_configured?: true }>;
  connectOAuth?(provider: TrackerProvider): Promise<TrackerConnectionView>;
  cancelOAuth?(): Promise<void>;
  saveApiToken(input: TrackerApiTokenInput): Promise<TrackerConnectionView>;
  connectGitHub(repository: string): Promise<TrackerConnectionView>;
  test(id: string): Promise<TrackerConnectionTestResult>;
  update(
    id: string,
    patch: TrackerConnectionPatch,
  ): Promise<TrackerConnectionView>;
  remove(id: string): Promise<void>;
  webhook(id: string): Promise<TrackerWebhookSetup>;
  rules: {
    list(id: string): Promise<TrackerRuleList>;
    create(id: string, input: TrackerRuleInput): Promise<TrackerRuleView>;
    update(
      id: string,
      ruleId: string,
      input: TrackerRuleInput,
    ): Promise<TrackerRuleView>;
    setEnabled(
      id: string,
      ruleId: string,
      enabled: boolean,
    ): Promise<TrackerRuleView>;
    versions(id: string, ruleId: string): Promise<TrackerRuleVersionView[]>;
    rollback(
      id: string,
      ruleId: string,
      version: number,
    ): Promise<TrackerRuleView>;
    remove(id: string, ruleId: string): Promise<void>;
    draft?(id: string, sentence: string): Promise<TrackerRuleDraftResult>;
  };
}
export interface RemoteConnection {
  id: string;
  client_name: string | null;
  redirect_hosts: string[];
  scope: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}
export interface ConnectorsApi {
  trackers: TrackerApi;
  remote: {
    list(): Promise<{ connections: RemoteConnection[] }>;
    disconnect(id: string): Promise<void>;
  };
}
export type AgentTarget = DesktopMcpInstallTarget;
export type ConnectorTab = "all" | "tracker" | "agent" | "remote";

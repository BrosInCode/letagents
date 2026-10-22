import { reactive } from "vue";
import type {
  TrackerConnectionView,
  TrackerProvider,
  TrackerProviderAvailability,
} from "../../../../../../../shared/ticket-connectors.mjs";
import { safeUserVisibleErrorDetail } from "../../../domain/user-visible-error";

type RemoteSignIn = Awaited<ReturnType<Window["letagentsDesktop"]["mcpConnections"]["list"]>>["connections"][number];

/**
 * One copy of the Connectors page data for the list and the panes, so the
 * list and the tracker or remote pane never ask the server twice or disagree.
 */
export const trackerConnectionsState = reactive({
  connections: [] as TrackerConnectionView[],
  providers: null as Record<TrackerProvider, TrackerProviderAvailability> | null,
  disclosure: "",
  loaded: false,
  /** The server has no connector key: the page shows that, not an error. */
  notConfigured: false,
  /** Text of a failed load; null when the list loaded or the server is not configured. */
  error: null as string | null,
  /** A tracker the Add catalog asked the Trackers pane to open the form for. */
  requestedForm: null as TrackerProvider | null,
});

export const remoteSignInsState = reactive({
  connections: [] as RemoteSignIn[],
  loaded: false,
  error: null as string | null,
});

let trackerLoad: Promise<void> | null = null;
let remoteLoad: Promise<void> | null = null;

export function loadTrackerConnections(): Promise<void> {
  trackerLoad ??= (async () => {
    try {
      const list = await window.letagentsDesktop.connectors.list();
      trackerConnectionsState.notConfigured = list.not_configured === true;
      trackerConnectionsState.connections = list.connections;
      trackerConnectionsState.providers = list.providers;
      trackerConnectionsState.disclosure = list.jev_linking_disclosure;
      trackerConnectionsState.error = null;
    } catch (error) {
      trackerConnectionsState.error = safeUserVisibleErrorDetail(error, "Trackers are not available. Sign in, then try again.");
    } finally {
      trackerConnectionsState.loaded = true;
      trackerLoad = null;
    }
  })();
  return trackerLoad;
}

export function loadRemoteSignIns(): Promise<void> {
  remoteLoad ??= (async () => {
    try {
      remoteSignInsState.connections = (await window.letagentsDesktop.mcpConnections.list()).connections;
      remoteSignInsState.error = null;
    } catch (error) {
      remoteSignInsState.error = safeUserVisibleErrorDetail(error, "Connected apps are not available. Sign in, then try again.");
    } finally {
      remoteSignInsState.loaded = true;
      remoteLoad = null;
    }
  })();
  return remoteLoad;
}

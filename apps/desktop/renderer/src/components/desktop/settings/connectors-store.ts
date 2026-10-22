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
// Bumped by every change a pane makes. A load that started before a change
// drops its answer, so a slow reload never brings back a removed connection.
let trackerVersion = 0;
let remoteVersion = 0;

/** Call when a pane changes the tracker list itself (connect, update, remove). */
export function trackerConnectionsChanged(): void {
  trackerVersion += 1;
}

/** Call when a pane changes the remote sign-in list itself (disconnect). */
export function remoteSignInsChanged(): void {
  remoteVersion += 1;
}

export function loadTrackerConnections(): Promise<void> {
  trackerLoad ??= (async () => {
    let list: Awaited<ReturnType<Window["letagentsDesktop"]["connectors"]["list"]>> | null = null;
    let failure: unknown = null;
    // A change made during the read makes its answer stale: read once more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const version = trackerVersion;
      try {
        list = await window.letagentsDesktop.connectors.list();
        failure = null;
      } catch (error) {
        list = null;
        failure = error;
      }
      if (version === trackerVersion) break;
      list = null;
      failure = null;
    }
    try {
      if (failure) throw failure;
      if (!list) return;
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
    let connections: RemoteSignIn[] | null = null;
    let failure: unknown = null;
    // A change made during the read makes its answer stale: read once more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const version = remoteVersion;
      try {
        connections = (await window.letagentsDesktop.mcpConnections.list()).connections;
        failure = null;
      } catch (error) {
        connections = null;
        failure = error;
      }
      if (version === remoteVersion) break;
      connections = null;
      failure = null;
    }
    try {
      if (failure) throw failure;
      if (!connections) return;
      remoteSignInsState.connections = connections;
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

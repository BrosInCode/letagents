import {
  mapApiRequest,
  mapApiRequestArray,
  mapApiSession,
  toApiCreateSessionBody,
} from "../api-mapper.js";
import { normalizeStartInput } from "./normalizers.js";
import {
  buildStubRequest,
  buildStubSession,
} from "./stubs.js";
import type {
  RentalIpcRegistrar,
  RentalIpcRegistrationContext,
} from "./types.js";

export function registerSessionHandlers(
  register: RentalIpcRegistrar,
  { apiClient }: RentalIpcRegistrationContext,
): void {
  register("desktop:rental:create-session", async (_event, input) => {
    const normalized = normalizeStartInput(input);
    if (apiClient) {
      const result = await apiClient.createSession(toApiCreateSessionBody(normalized));
      if (result.ok) {
        const mapped = mapApiSession(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubSession("session_stub", normalized);
  });

  register("desktop:rental:get-session", async (_event, id) => {
    const sessionId = String(id);
    if (apiClient) {
      const result = await apiClient.getSession(sessionId);
      if (result.ok) {
        const mapped = mapApiSession(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubSession(sessionId);
  });

  register("desktop:rental:cancel-session", async (_event, id) => {
    const sessionId = String(id);
    if (apiClient) {
      const result = await apiClient.cancelSession(sessionId);
      if (result.ok) {
        const mapped = mapApiSession(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubSession(sessionId, undefined, "cancelled");
  });

  register("desktop:rental:list-provider-requests", async () => {
    if (apiClient) {
      const result = await apiClient.listProviderRequests();
      if (result.ok) return mapApiRequestArray(result.body);
    }
    return [];
  });

  register("desktop:rental:accept-request", async (_event, id) => {
    const sessionId = String(id);
    if (apiClient) {
      const result = await apiClient.acceptRequest(sessionId);
      if (result.ok) {
        const mapped = mapApiSession(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubSession(sessionId, undefined, "accepted");
  });

  register("desktop:rental:decline-request", async (_event, id) => {
    const sessionId = String(id);
    if (apiClient) {
      const result = await apiClient.declineRequest(sessionId);
      if (result.ok) {
        const mapped = mapApiRequest(result.body);
        if (mapped) return mapped;
      }
    }
    return buildStubRequest(sessionId, "declined");
  });
}

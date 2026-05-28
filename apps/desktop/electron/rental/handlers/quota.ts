import { toApiDeclareQuotaBody } from "../api-mapper.js";
import { normalizeManualDeclareInput } from "./normalizers.js";
import type {
  RentalIpcRegistrar,
  RentalIpcRegistrationContext,
} from "./types.js";

export function registerQuotaHandlers(
  register: RentalIpcRegistrar,
  { apiClient, renterTriggerRuntime }: RentalIpcRegistrationContext,
): void {
  register("desktop:rental:get-own-quota-status", () =>
    renterTriggerRuntime.getOwnQuotaStatus(),
  );

  register("desktop:rental:declare-quota-exhausted", (_event, input) => {
    const signal = renterTriggerRuntime.declareManual(
      normalizeManualDeclareInput(input),
    );
    if (apiClient) {
      const body = toApiDeclareQuotaBody(signal);
      if (body) {
        void apiClient.declareQuotaExhausted(body).catch(() => {});
      }
    }
    return signal;
  });
}

/**
 * Desktop-side API mapper facade.
 *
 * The public import path stays stable for Electron handlers while the mapper
 * implementation lives under ./api-mapper by rental domain.
 */

export {
  mapApiActivityEvent,
} from "./api-mapper/activity.js";
export {
  mapApiActivityEventArray,
  mapApiContextApprovalArray,
  mapApiExposureArray,
  mapApiListingArray,
  mapApiPatchArray,
  mapApiRequestArray,
} from "./api-mapper/arrays.js";
export {
  mapApiContextApproval,
  mapApiExposure,
} from "./api-mapper/context.js";
export {
  mapApiListing,
} from "./api-mapper/listing.js";
export {
  mapApiPatch,
} from "./api-mapper/patch.js";
export {
  mapApiProviderReadiness,
} from "./api-mapper/readiness.js";
export {
  mapApiQuotaSnapshot,
} from "./api-mapper/quota.js";
export {
  mapApiRequest,
} from "./api-mapper/request.js";
export {
  mapApiSession,
} from "./api-mapper/session.js";
export {
  mapApiUsageSnapshot,
} from "./api-mapper/usage.js";
export {
  toApiCreateSessionBody,
  toApiDeclareQuotaBody,
  toApiListingCreateBody,
  toApiListingPatchBody,
} from "./api-mapper/outbound.js";

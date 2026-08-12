import {
  claimAmbiguousWorkflowEffect,
  claimFailedWorkflowEffect,
  getWorkflowEffect,
  listReconcilableWorkflowEffects,
  markStalePendingWorkflowEffectAmbiguous,
  markWorkflowEffectAmbiguous,
  markWorkflowEffectFailed,
  markWorkflowEffectSucceeded,
  pruneSettledWorkflowEffects,
  releaseWorkflowEffectLookup,
  reserveWorkflowEffect,
} from "../db.js";
import { createWorkflowEffectBroker } from "./broker.js";
import { createGitHubReviewProvider } from "./github-review-provider.js";

export const workflowEffectBroker = createWorkflowEffectBroker({
  store: {
    reserve: reserveWorkflowEffect,
    get: getWorkflowEffect,
    claimFailed: claimFailedWorkflowEffect,
    claimAmbiguous: claimAmbiguousWorkflowEffect,
    stalePendingToAmbiguous: markStalePendingWorkflowEffectAmbiguous,
    succeed: markWorkflowEffectSucceeded,
    fail: markWorkflowEffectFailed,
    ambiguous: markWorkflowEffectAmbiguous,
    releaseLookup: releaseWorkflowEffectLookup,
    listReconcilable: listReconcilableWorkflowEffects,
    pruneSettled: pruneSettledWorkflowEffects,
  },
  provider: createGitHubReviewProvider(),
});

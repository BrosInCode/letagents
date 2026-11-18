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
  reserveTrackerWorkflowEffect,
  reserveWorkflowEffect,
} from "../db.js";
import { createConnectionService } from "../connectors/connections.js";
import { loadConnectorCipher } from "../connectors/crypto.js";
import { createTrackerEffectExecutor } from "../connectors/effects.js";
import { createWorkItemProviders } from "../connectors/providers/index.js";
import { trackerConnectionStore } from "../connectors/store.js";
import { API_INTENT_EFFECT_KEY_PREFIX } from "../intents/ticket-executor.js";
import { createWorkflowEffectBroker } from "./broker.js";
import { createGitHubReviewProvider } from "./github-review-provider.js";

function trackerExecutor() {
  const cipher = loadConnectorCipher();
  if (!cipher) return undefined;
  const providers = createWorkItemProviders();
  return createTrackerEffectExecutor({
    store: trackerConnectionStore,
    service: createConnectionService({ store: trackerConnectionStore, cipher, providers }),
    providers,
  });
}

export const workflowEffectBroker = createWorkflowEffectBroker({
  store: {
    reserve: reserveWorkflowEffect,
    reserveTracker: reserveTrackerWorkflowEffect,
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
  tracker: trackerExecutor(),
  // An API intent's ticket write finishes the intent when it settles.
  onSettled: async (effect) => {
    if (!effect.idempotency_key.startsWith(API_INTENT_EFFECT_KEY_PREFIX)) return;
    const { settleIntentFromEffect } = await import("../intents/service.js");
    await settleIntentFromEffect(effect);
  },
});

import { inject, provide, type ComputedRef } from "vue";

type PullRequestDiffContext = { room: ComputedRef<string>; repository: ComputedRef<string | null> };
const key = Symbol("pull-request-diff");
export function providePullRequestDiffContext(context: PullRequestDiffContext): void { provide(key, context); }
export function usePullRequestDiffContext(): PullRequestDiffContext | null { return inject<PullRequestDiffContext | null>(key, null); }

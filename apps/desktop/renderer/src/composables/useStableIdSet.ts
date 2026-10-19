import { shallowReactive, watch } from "vue";

/**
 * Bring `target` to hold exactly `ids`, touching it only where membership
 * differs. Returns the number of add/delete operations done.
 */
export function syncIdSet(target: Set<string>, ids: Iterable<string>): number {
  const next = ids instanceof Set ? ids : new Set(ids);
  let operations = 0;
  for (const id of next) {
    if (!target.has(id)) {
      target.add(id);
      operations += 1;
    }
  }
  if (target.size !== next.size) {
    for (const id of [...target]) {
      if (!next.has(id)) {
        target.delete(id);
        operations += 1;
      }
    }
  }
  return operations;
}

/**
 * A set of ids with a stable identity that is edited in place.
 *
 * Passing `new Set(...)` as a prop changes the prop on every update, and Vue
 * re-renders every child that receives it. Here the object never changes, so
 * children keep their props. Vue tracks `has(id)` per key on a reactive set, so
 * a child that looked up `msg_7` re-runs only when `msg_7` is added or removed.
 *
 * Invalidation rule: the set follows `source`, synced before render. Its size
 * is the size of the latest `source` result, so it cannot grow without bound.
 */
export function useStableIdSet(source: () => Iterable<string>): ReadonlySet<string> {
  const set = shallowReactive(new Set<string>());
  watch(source, (ids) => { syncIdSet(set, ids); }, { immediate: true });
  return set;
}

export type PaginatedTaskPage<T> = {
  tasks?: readonly T[] | null;
  has_more?: boolean | null;
};

export async function drainPaginatedTaskPages<T extends { id: string }>(
  fetchPage: (after?: string) => Promise<PaginatedTaskPage<T>>,
): Promise<T[]> {
  const tasksById = new Map<string, T>();
  const seenCursors = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const page = await fetchPage(after);
    for (const task of page.tasks || []) {
      tasksById.set(task.id, task);
    }

    if (!page.has_more) break;

    const nextCursor = page.tasks?.at(-1)?.id;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    after = nextCursor;
  }

  return [...tasksById.values()];
}

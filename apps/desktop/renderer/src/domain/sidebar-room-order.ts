import type { ProjectGroup, RoomEntry } from "../components/desktop/types";

type SidebarRoomOrderStorage = Pick<Storage, "getItem" | "setItem">;

export type SidebarRoomDropPlacement = "before" | "after";

export type SidebarRoomOrder = {
  pinnedParentIds: string[];
  roomParentIds: string[];
  childIdsByProject: Record<string, string[]>;
};

export type SidebarParentRoomReorder = {
  sourceProjectId: string;
  targetProjectId: string;
  placement: SidebarRoomDropPlacement;
};

export type SidebarChildRoomReorder = {
  projectId: string;
  sourceEntryId: string;
  targetEntryId: string;
  placement: SidebarRoomDropPlacement;
};

export type SidebarKeyboardRoomReorder<T> = {
  target: T;
  placement: SidebarRoomDropPlacement;
};

export const emptySidebarRoomOrder: SidebarRoomOrder = {
  pinnedParentIds: [],
  roomParentIds: [],
  childIdsByProject: {},
};

export function readStoredSidebarRoomOrder(
  storage: Pick<SidebarRoomOrderStorage, "getItem">,
  storageKey: string,
): SidebarRoomOrder {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return emptySidebarRoomOrder;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptySidebarRoomOrder;
    return {
      pinnedParentIds: stringList(parsed.pinnedParentIds),
      roomParentIds: stringList(parsed.roomParentIds),
      childIdsByProject: stringListRecord(parsed.childIdsByProject),
    };
  } catch {
    return emptySidebarRoomOrder;
  }
}

export function rememberSidebarRoomOrder(
  storage: Pick<SidebarRoomOrderStorage, "setItem">,
  storageKey: string,
  order: SidebarRoomOrder,
): void {
  try {
    storage.setItem(storageKey, JSON.stringify(order));
  } catch {
    // Sidebar navigation should remain usable when local persistence is unavailable.
  }
}

export function applySidebarRoomOrder(
  projects: readonly ProjectGroup[],
  order: SidebarRoomOrder,
): ProjectGroup[] {
  const pinned = orderByIds(projects.filter((project) => project.parent.pinned), order.pinnedParentIds);
  const rooms = orderByIds(projects.filter((project) => !project.parent.pinned), order.roomParentIds);
  return [...pinned, ...rooms].map((project) => ({
    ...project,
    childRoomOrder: orderByIds(
      [...project.branchRooms, ...project.focusRooms],
      order.childIdsByProject[project.id] || [],
    ).map((entry) => entry.id),
  }));
}

export function orderedSidebarChildRooms(project: ProjectGroup | null | undefined): RoomEntry[] {
  if (!project) return [];
  return orderByIds(
    [...project.branchRooms, ...project.focusRooms],
    project.childRoomOrder || [],
  );
}

export function isSidebarRoomReorderEnabled(
  selectionActive: boolean,
  batchActionBusy: boolean,
): boolean {
  return !selectionActive && !batchActionBusy;
}

export function resolveSidebarKeyboardRoomReorder<T extends { id: string }>(
  visibleEntries: readonly T[],
  sourceId: string,
  direction: -1 | 1,
): SidebarKeyboardRoomReorder<T> | null {
  const sourceIndex = visibleEntries.findIndex((entry) => entry.id === sourceId);
  if (sourceIndex < 0) return null;
  const target = visibleEntries[sourceIndex + direction];
  if (!target) return null;
  return {
    target,
    placement: direction < 0 ? "before" : "after",
  };
}

export function reorderSidebarParentRooms(
  projects: readonly ProjectGroup[],
  input: SidebarParentRoomReorder,
): SidebarRoomOrder | null {
  const source = projects.find((project) => project.id === input.sourceProjectId);
  const target = projects.find((project) => project.id === input.targetProjectId);
  if (!source || !target || source.parent.pinned !== target.parent.pinned) return null;

  const canonical = canonicalSidebarRoomOrder(projects);
  const key = source.parent.pinned ? "pinnedParentIds" : "roomParentIds";
  const moved = moveId(canonical[key], source.id, target.id, input.placement);
  if (!moved) return null;
  return { ...canonical, [key]: moved };
}

export function reorderSidebarChildRooms(
  projects: readonly ProjectGroup[],
  input: SidebarChildRoomReorder,
): SidebarRoomOrder | null {
  const project = projects.find((candidate) => candidate.id === input.projectId);
  if (!project) return null;
  const childIds = orderedSidebarChildRooms(project).map((entry) => entry.id);
  const moved = moveId(childIds, input.sourceEntryId, input.targetEntryId, input.placement);
  if (!moved) return null;

  const canonical = canonicalSidebarRoomOrder(projects);
  return {
    ...canonical,
    childIdsByProject: {
      ...canonical.childIdsByProject,
      [project.id]: moved,
    },
  };
}

function canonicalSidebarRoomOrder(projects: readonly ProjectGroup[]): SidebarRoomOrder {
  return {
    pinnedParentIds: projects.filter((project) => project.parent.pinned).map((project) => project.id),
    roomParentIds: projects.filter((project) => !project.parent.pinned).map((project) => project.id),
    childIdsByProject: Object.fromEntries(
      projects.map((project) => [
        project.id,
        orderedSidebarChildRooms(project).map((entry) => entry.id),
      ]),
    ),
  };
}

function moveId(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  placement: SidebarRoomDropPlacement,
): string[] | null {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return null;
  const remaining = ids.filter((id) => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  remaining.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceId);
  return remaining;
}

function orderByIds<T extends { id: string }>(entries: readonly T[], ids: readonly string[]): T[] {
  const rememberedIndex = new Map(ids.map((id, index) => [id, index]));
  return entries
    .map((entry, index) => ({ entry, index, remembered: rememberedIndex.get(entry.id) }))
    .sort((left, right) => {
      if (left.remembered !== undefined && right.remembered !== undefined) {
        return left.remembered - right.remembered;
      }
      if (left.remembered !== undefined) return -1;
      if (right.remembered !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function stringListRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => Boolean(key.trim()))
      .map(([key, entry]) => [key, stringList(entry)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

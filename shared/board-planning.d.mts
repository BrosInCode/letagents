/** Board presentation and sprint planning. Task execution authority stays in the task lifecycle. */
export declare const BOARD_TASK_STATUSES: readonly ["accepted", "assigned", "in_progress", "blocked", "in_review", "merged", "done"];
export type BoardTaskStatus = typeof BOARD_TASK_STATUSES[number];
export type BoardSprintState = "future" | "active" | "closed";
export interface BoardColumn {
    id: string;
    name: string;
    /** A custom column subdivides these existing lifecycle states; it never creates a new state. */
    statuses: BoardTaskStatus[];
}
export interface BoardSprint {
    id: string;
    name: string;
    state: BoardSprintState;
    startDate: string | null;
    endDate: string | null;
    goal: string | null;
    source?: {
        provider: string;
        id: string;
        connectionId: string;
        /** Source state may be cached; stale state must not drive sprint targets or pace. */
        checkedAt?: string;
        stale?: boolean;
    };
}
export interface BoardTaskPlanning {
    /** Missing uses an imported value; null explicitly means no sprint / no estimate. */
    sprintId?: string | null;
    estimate?: number | null;
    columnId?: string | null;
    type?: "task" | "bug" | "feature";
    priority?: "low" | "medium" | "high" | "urgent";
}
export interface BoardPlanningDocument {
    columns: BoardColumn[];
    sprints: BoardSprint[];
    defaultTargetPoints: number;
    /** Explicit targets by native or imported sprint ID. */
    sprintTargets: Record<string, number>;
    tasks: Record<string, BoardTaskPlanning>;
}
export interface BoardImportedPlanning {
    sprints: BoardSprint[];
    tasks: Record<string, BoardTaskPlanning & {
        /** Provider-assigned person, independent of the room worker executing the task. */
        assigneeId?: string | null;
        assigneeName?: string | null;
        assigneeAvatarUrl?: string | null;
        sprintIds?: string[];
        /** Tracker state is separate from the room task's execution lifecycle. */
        ticketState?: string;
        done?: boolean;
    }>;
}
export interface BoardTaskFact {
    id: string;
    title: string;
    status: string;
    assignee: string | null;
    assigneeAgentKey: string | null;
    provider: string | null;
    prUrl: string | null;
    externalRef: string | null;
    ticketUrl: string | null;
    updatedAt: string;
}
export interface BoardPlanningSnapshot {
    roomId: string;
    revision: number;
    document: BoardPlanningDocument;
    imported: BoardImportedPlanning;
    /** Complete room facts, including finished tasks, independent of task-list pagination. */
    taskFacts: BoardTaskFact[];
    canEdit: boolean;
}
export interface BoardPlanningUpdate {
    expectedRevision: number;
    document: BoardPlanningDocument;
}
export declare function defaultBoardPlanning(): BoardPlanningDocument;
export declare class BoardPlanningInputError extends Error {
}
export declare class BoardPlanningConflictError extends Error {
    constructor();
}
/** Rebuild the allowed fields rather than persisting arbitrary client JSON. */
export declare function validateBoardPlanningUpdate(value: unknown): BoardPlanningUpdate;
export declare function boardTaskPlanning(snapshot: Pick<BoardPlanningSnapshot, "document" | "imported">, taskId: string): BoardTaskPlanning;
/** Ignore stale placement after an authoritative lifecycle change. Always fall back to a visible column. */
export declare function boardTaskColumn(document: BoardPlanningDocument, task: Pick<BoardTaskFact, "id" | "status">): string | null;
export declare function validateBoardPlanningReferences(document: BoardPlanningDocument, taskIds: ReadonlySet<string>, importedSprintIds: ReadonlySet<string>): void;

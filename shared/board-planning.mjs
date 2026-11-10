/** Board presentation and sprint planning. Task execution authority stays in the task lifecycle. */
export const BOARD_TASK_STATUSES = ["accepted", "assigned", "in_progress", "blocked", "in_review", "merged", "done"];
export function defaultBoardPlanning() {
    return {
        columns: [
            { id: "todo", name: "To do", statuses: ["accepted", "assigned"] },
            { id: "progress", name: "In progress", statuses: ["in_progress", "blocked"] },
            { id: "review", name: "In review", statuses: ["in_review"] },
            { id: "done", name: "Done", statuses: ["merged", "done"] },
        ],
        sprints: [], defaultTargetPoints: 16, sprintTargets: {}, tasks: {},
    };
}
export class BoardPlanningInputError extends Error {
}
export class BoardPlanningConflictError extends Error {
    constructor() { super("The board changed while you were editing. Refresh the board and try again."); }
}
const fail = (message) => { throw new BoardPlanningInputError(message); };
const object = (value, name) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fail(`${name} must be an object.`);
    return value;
};
function text(value, name, max, multiline = false) {
    const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/ : /[\u0000-\u001f]/;
    if (typeof value !== "string" || !value.trim() || value.length > max || controls.test(value))
        return fail(`${name} is invalid.`);
    return value.trim();
}
function id(value, name) {
    const result = text(value, name, 240);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(result))
        return fail(`${name} is invalid.`);
    return result;
}
function target(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000)
        return fail("Sprint targets must be whole numbers from 1 to 1,000.");
    return value;
}
function date(value) {
    if (value === null)
        return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
        return fail("Sprint dates must be valid calendar dates.");
    return value;
}
/** Rebuild the allowed fields rather than persisting arbitrary client JSON. */
export function validateBoardPlanningUpdate(value) {
    const input = object(value, "Board update");
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0)
        fail("The board revision is invalid.");
    const raw = object(input.document, "Board planning");
    if (!Array.isArray(raw.columns) || raw.columns.length < 1 || raw.columns.length > 30)
        fail("A board needs between 1 and 30 columns.");
    const columns = raw.columns.map(value => {
        const column = object(value, "Column");
        if (!Array.isArray(column.statuses) || !column.statuses.length || column.statuses.some(status => !BOARD_TASK_STATUSES.includes(status)))
            fail("Choose existing task states for each column.");
        return { id: id(column.id, "Column ID"), name: text(column.name, "Column name", 80), statuses: [...new Set(column.statuses)] };
    });
    if (new Set(columns.map(column => column.id)).size !== columns.length)
        fail("Column IDs must be unique.");
    if (BOARD_TASK_STATUSES.some(status => !columns.some(column => column.statuses.includes(status))))
        fail("Every task state needs a column so work cannot disappear.");
    if (!Array.isArray(raw.sprints) || raw.sprints.length > 200)
        fail("A board can have at most 200 native sprints.");
    const sprints = raw.sprints.map(value => {
        const sprint = object(value, "Sprint");
        if (!["future", "active", "closed"].includes(String(sprint.state)))
            fail("Sprint state is invalid.");
        const startDate = date(sprint.startDate), endDate = date(sprint.endDate);
        if ((startDate === null) !== (endDate === null) || (startDate && endDate && startDate > endDate))
            fail("Choose a sprint start and end date in order.");
        const sprintId = id(sprint.id, "Sprint ID");
        if (sprintId.startsWith("imported:"))
            fail("Imported sprints cannot be edited here.");
        return { id: sprintId, name: text(sprint.name, "Sprint name", 160), state: sprint.state, startDate, endDate, goal: sprint.goal === null ? null : text(sprint.goal, "Sprint goal", 2000, true) };
    });
    if (new Set(sprints.map(sprint => sprint.id)).size !== sprints.length)
        fail("Sprint IDs must be unique.");
    const sprintTargets = {};
    const targets = object(raw.sprintTargets, "Sprint targets");
    if (Object.keys(targets).length > 1000)
        fail("Too many sprint targets.");
    for (const [key, value] of Object.entries(targets))
        sprintTargets[id(key, "Sprint ID")] = target(value);
    const taskValues = object(raw.tasks, "Task planning");
    if (Object.keys(taskValues).length > 20000)
        fail("Too many planned tasks.");
    const tasks = {};
    for (const [key, value] of Object.entries(taskValues)) {
        const taskId = id(key, "Task ID"), task = object(value, "Task planning"), result = {};
        if (Object.hasOwn(task, "sprintId"))
            result.sprintId = task.sprintId === null ? null : id(task.sprintId, "Sprint ID");
        if (Object.hasOwn(task, "estimate")) {
            if (task.estimate !== null && (typeof task.estimate !== "number" || !Number.isFinite(task.estimate) || task.estimate < 0 || task.estimate > 1000))
                fail("Story points must be between 0 and 1,000, or left unestimated.");
            result.estimate = task.estimate;
        }
        if (Object.hasOwn(task, "columnId")) {
            result.columnId = task.columnId === null ? null : id(task.columnId, "Column ID");
            if (result.columnId && !columns.some(column => column.id === result.columnId))
                fail("A planned task references a missing column.");
        }
        if (Object.hasOwn(task, "type")) {
            if (!["task", "bug", "feature"].includes(String(task.type)))
                fail("Task type is invalid.");
            result.type = task.type;
        }
        if (Object.hasOwn(task, "priority")) {
            if (!["low", "medium", "high", "urgent"].includes(String(task.priority)))
                fail("Task priority is invalid.");
            result.priority = task.priority;
        }
        tasks[taskId] = result;
    }
    let releaseRule;
    if (Object.hasOwn(raw, "releaseRule")) {
        if (raw.releaseRule === null) releaseRule = null;
        else {
            const rule = object(raw.releaseRule, "Release rule");
            if (rule.kind === "column") {
                const columnId = id(rule.columnId, "Release column");
                if (!columns.some(column => column.id === columnId)) fail("Choose an existing release column.");
                releaseRule = { kind: "column", columnId };
            } else if (rule.kind === "tracker") {
                releaseRule = { kind: "tracker", connectionId: id(rule.connectionId, "Tracker connection"),
                    fieldId: id(rule.fieldId, "Release field"), value: text(rule.value, "Release value", 240) };
            } else fail("Choose a column or tracker condition for releases.");
        }
    }
    return { expectedRevision: Number(input.expectedRevision), document: { columns, sprints, defaultTargetPoints: target(raw.defaultTargetPoints), sprintTargets, tasks,
        ...(releaseRule !== undefined ? { releaseRule } : {}) } };
}
export function boardTaskPlanning(snapshot, taskId) {
    return { ...snapshot.imported.tasks[taskId], ...snapshot.document.tasks[taskId] };
}
/** Ignore stale placement after an authoritative lifecycle change. Always fall back to a visible column. */
export function boardTaskColumn(document, task) {
    const placement = document.tasks[task.id]?.columnId;
    const matching = document.columns.filter(column => column.statuses.includes(task.status));
    return matching.find(column => column.id === placement)?.id ?? matching[0]?.id ?? null;
}
export function validateBoardPlanningReferences(document, taskIds, importedSprintIds) {
    if (document.releaseRule?.kind === "column" && !document.columns.some(column => column.id === document.releaseRule.columnId))
        throw new BoardPlanningInputError("The release column was removed. Update Releases in board settings.");
    const sprintIds = new Set([...document.sprints.map(sprint => sprint.id), ...importedSprintIds]);
    for (const [taskId, planning] of Object.entries(document.tasks)) {
        if (!taskIds.has(taskId))
            throw new BoardPlanningInputError("A planned task no longer exists in this room. Refresh the board.");
        if (planning.sprintId && !sprintIds.has(planning.sprintId))
            throw new BoardPlanningInputError("A planned task references a missing sprint. Refresh the board and try again.");
    }
    for (const sprintId of Object.keys(document.sprintTargets)) {
        if (!sprintIds.has(sprintId))
            throw new BoardPlanningInputError("A target references a missing sprint. Refresh the board and try again.");
    }
}

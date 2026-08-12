import { and, asc, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "./client.js";
import { acquireLeaseFenceTx, LeaseFenceStaleError, type LeaseFence } from "./coordination/lease-rebind.js";
import { toRoomSharedArtifact, toRoomSharedArtifactTaskLink } from "./mappers.js";
import { room_shared_artifact_tasks, room_shared_artifacts } from "./schema.js";
import type {
  RoomSharedArtifact,
  RoomSharedArtifactSource,
  RoomSharedArtifactTaskLink,
} from "./types.js";
import type { TaskWorkflowArtifact } from "../repo-workflow.js";

// A drizzle transaction or the base client — lets a write run standalone or
// enrolled in a caller's transaction (e.g. under a lease fence).
type ArtifactWriteExecutor = Pick<typeof db, "insert" | "select" | "delete">;

export function buildRoomSharedArtifactIdentityKey(
  artifact: Pick<TaskWorkflowArtifact, "provider" | "kind" | "url" | "id" | "number" | "ref" | "title">
): string {
  const provider = artifact.provider || "unknown";
  const kind = artifact.kind;

  if (artifact.url) return `${provider}:${kind}:url:${artifact.url}`;
  if (artifact.id) return `${provider}:${kind}:id:${artifact.id}`;
  if (artifact.number !== undefined && artifact.number !== null) {
    return `${provider}:${kind}:number:${artifact.number}`;
  }
  if (artifact.ref) return `${provider}:${kind}:ref:${artifact.ref}`;
  if (artifact.title) return `${provider}:${kind}:title:${artifact.title}`;
  return `${provider}:${kind}:generic`;
}

export function preserveManualRoomSharedArtifactInput(input: {
  artifact: TaskWorkflowArtifact;
  source: RoomSharedArtifactSource;
  existing?: Pick<
    RoomSharedArtifact,
    "artifact_id" | "artifact_number" | "title" | "url" | "ref" | "state" | "source"
  > | null;
}): { artifact: TaskWorkflowArtifact; source: RoomSharedArtifactSource } {
  const { artifact, existing } = input;
  if (!existing) {
    return { artifact, source: input.source };
  }

  const preserveExistingValues = existing.source === "manual" && input.source !== "manual";
  const nextValue = <T>(incoming: T | null | undefined, current: T | null | undefined): T | undefined => {
    const first = preserveExistingValues ? current : incoming;
    const second = preserveExistingValues ? incoming : current;
    return first ?? second ?? undefined;
  };

  return {
    source: input.source === "manual" || existing.source === "manual"
      ? existing.source
      : input.source,
    artifact: {
      provider: artifact.provider,
      kind: artifact.kind,
      id: nextValue(artifact.id, existing.artifact_id),
      number: nextValue(artifact.number, existing.artifact_number),
      title: nextValue(artifact.title, existing.title),
      url: nextValue(artifact.url, existing.url),
      ref: nextValue(artifact.ref, existing.ref),
      state: nextValue(artifact.state, existing.state),
      // detail is intentionally NOT preserved here — it is derived current-state
      // data owned wholesale by each publish (see upsertRoomSharedArtifact), so a
      // clean update (no detail) must clear a prior file list rather than keep it.
    },
  };
}

export async function upsertRoomSharedArtifact(input: {
  room_id: string;
  artifact: TaskWorkflowArtifact;
  source?: RoomSharedArtifactSource;
}, executor: ArtifactWriteExecutor = db): Promise<RoomSharedArtifact> {
  const now = new Date().toISOString();
  const identityKey = buildRoomSharedArtifactIdentityKey(input.artifact);
  const requestedSource = input.source ?? "task_workflow_artifact";
  const existingArtifact = await getRoomSharedArtifactByIdentityKey({
    room_id: input.room_id,
    identity_key: identityKey,
  }, executor);
  const { artifact, source } = preserveManualRoomSharedArtifactInput({
    artifact: input.artifact,
    source: requestedSource,
    existing: existingArtifact,
  });
  // Detail write action, computed in JS so null vs undefined is distinguishable:
  //  - clear   : state === "clean" or explicit null  -> write null
  //  - set     : a provided value                     -> write it
  //  - preserve : omitted (undefined)                 -> leave the column untouched
  // Preserve is implemented by OMITTING detail from the UPDATE set (not by reading
  // the existing value and writing it back), which avoids a lost-update race.
  const detailAction: "set" | "clear" | "preserve" =
    input.artifact.state === "clean" || input.artifact.detail === null
      ? "clear"
      : input.artifact.detail !== undefined
        ? "set"
        : "preserve";
  const detailValue = detailAction === "set" ? (input.artifact.detail ?? null) : null;

  const [row] = await executor
    .insert(room_shared_artifacts)
    .values({
      room_id: input.room_id,
      identity_key: identityKey,
      provider: artifact.provider,
      kind: artifact.kind,
      artifact_id: artifact.id ?? null,
      artifact_number: artifact.number ?? null,
      title: artifact.title ?? null,
      url: artifact.url ?? null,
      ref: artifact.ref ?? null,
      state: artifact.state ?? null,
      detail: detailValue,
      source,
      first_seen_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [room_shared_artifacts.room_id, room_shared_artifacts.identity_key],
      set: {
        provider: artifact.provider,
        kind: artifact.kind,
        artifact_id: artifact.id ?? null,
        artifact_number: artifact.number ?? null,
        title: artifact.title ?? null,
        url: artifact.url ?? null,
        ref: artifact.ref ?? null,
        state: artifact.state ?? null,
        source,
        updated_at: now,
        // Omitted entirely on "preserve" so the stored file list is left intact.
        ...(detailAction !== "preserve" ? { detail: detailValue } : {}),
      },
    })
    .returning();

  return toRoomSharedArtifact(row, []);
}

export async function linkRoomSharedArtifactToTask(input: {
  room_id: string;
  artifact_identity_key: string;
  task_id: string;
  source?: RoomSharedArtifactSource;
}, executor: ArtifactWriteExecutor = db): Promise<RoomSharedArtifactTaskLink> {
  const now = new Date().toISOString();
  const source = input.source ?? "task_workflow_artifact";
  const [row] = await executor
    .insert(room_shared_artifact_tasks)
    .values({
      room_id: input.room_id,
      artifact_identity_key: input.artifact_identity_key,
      task_id: input.task_id,
      source,
      linked_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        room_shared_artifact_tasks.room_id,
        room_shared_artifact_tasks.artifact_identity_key,
        room_shared_artifact_tasks.task_id,
      ],
      set: {
        source,
        updated_at: now,
      },
    })
    .returning();

  return toRoomSharedArtifactTaskLink(row);
}

// Publish a worker's artifact and link it to the task it belongs to, ATOMICALLY
// and fenced on the caller's held work lease (plan §4.5). The upsert and the
// task link were previously two separate writes with no fence: a rebound-away
// predecessor could bind an artifact to a task whose lease had already moved,
// and a crash between the two left a dangling upsert. Both now run in one tx
// that first re-validates the lease under the shared advisory lock, so a
// concurrent rebind advances the epoch and the whole publish aborts with
// LeaseFenceStaleError — no partial write, no stale binding.
export async function publishWorkerArtifactFenced(input: {
  leaseFence: LeaseFence;
  room_id: string;
  artifact: TaskWorkflowArtifact;
  linked_task_id: string;
  source?: RoomSharedArtifactSource;
}): Promise<RoomSharedArtifact> {
  return db.transaction(async (tx) => {
    const held = await acquireLeaseFenceTx(tx, input.leaseFence);
    if (!held) throw new LeaseFenceStaleError();
    const artifact = await upsertRoomSharedArtifact(
      { room_id: input.room_id, artifact: input.artifact, source: input.source },
      tx
    );
    await linkRoomSharedArtifactToTask(
      {
        room_id: input.room_id,
        artifact_identity_key: artifact.identity_key,
        task_id: input.linked_task_id,
        source: input.source,
      },
      tx
    );
    return artifact;
  });
}

export async function getRoomSharedArtifactByIdentityKey(input: {
  room_id: string;
  identity_key: string;
}, executor: ArtifactWriteExecutor = db): Promise<RoomSharedArtifact | null> {
  const [artifact] = await executor
    .select()
    .from(room_shared_artifacts)
    .where(
      and(
        eq(room_shared_artifacts.room_id, input.room_id),
        eq(room_shared_artifacts.identity_key, input.identity_key)
      )
    )
    .limit(1);

  if (!artifact) {
    return null;
  }

  const links = await executor
    .select()
    .from(room_shared_artifact_tasks)
    .where(
      and(
        eq(room_shared_artifact_tasks.room_id, input.room_id),
        eq(room_shared_artifact_tasks.artifact_identity_key, input.identity_key)
      )
    )
    .orderBy(asc(room_shared_artifact_tasks.task_id));

  return toRoomSharedArtifact(
    artifact,
    links.map((link) => link.task_id)
  );
}

export async function syncRoomSharedArtifactsForTask(input: {
  room_id: string;
  task_id: string;
  artifacts: TaskWorkflowArtifact[];
  source?: RoomSharedArtifactSource;
}, executor: ArtifactWriteExecutor = db): Promise<RoomSharedArtifact[]> {
  const source = input.source ?? "task_workflow_artifact";
  const synced: RoomSharedArtifact[] = [];
  const identityKeys: string[] = [];

  for (const artifact of input.artifacts) {
    const sharedArtifact = await upsertRoomSharedArtifact({
      room_id: input.room_id,
      artifact,
      source,
    }, executor);
    synced.push(sharedArtifact);
    identityKeys.push(sharedArtifact.identity_key);
    await linkRoomSharedArtifactToTask({
      room_id: input.room_id,
      artifact_identity_key: sharedArtifact.identity_key,
      task_id: input.task_id,
      source,
    }, executor);
  }

  const taskLinkConditions = [
    eq(room_shared_artifact_tasks.room_id, input.room_id),
    eq(room_shared_artifact_tasks.task_id, input.task_id),
    eq(room_shared_artifact_tasks.source, source),
  ];
  await executor
    .delete(room_shared_artifact_tasks)
    .where(
      identityKeys.length
        ? and(
            ...taskLinkConditions,
            notInArray(room_shared_artifact_tasks.artifact_identity_key, identityKeys)
          )
        : and(...taskLinkConditions)
    );

  return synced;
}

export async function getRoomSharedArtifacts(input: {
  room_id: string;
  task_id?: string | null;
  limit?: number;
}): Promise<RoomSharedArtifact[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 250));
  const artifactRows = input.task_id
    ? (await db
        .select({ artifact: room_shared_artifacts })
        .from(room_shared_artifacts)
        .innerJoin(
          room_shared_artifact_tasks,
          and(
            eq(room_shared_artifacts.room_id, room_shared_artifact_tasks.room_id),
            eq(room_shared_artifacts.identity_key, room_shared_artifact_tasks.artifact_identity_key),
            eq(room_shared_artifact_tasks.task_id, input.task_id)
          )
        )
        .where(eq(room_shared_artifacts.room_id, input.room_id))
        .orderBy(asc(room_shared_artifacts.kind), asc(room_shared_artifacts.identity_key))
        .limit(limit)).map((row) => row.artifact)
    : await db
        .select()
        .from(room_shared_artifacts)
        .where(eq(room_shared_artifacts.room_id, input.room_id))
        .orderBy(asc(room_shared_artifacts.kind), asc(room_shared_artifacts.identity_key))
        .limit(limit);

  if (!artifactRows.length) {
    return [];
  }

  const identityKeys = artifactRows.map((artifact) => artifact.identity_key);
  const taskLinkConditions = [
    eq(room_shared_artifact_tasks.room_id, input.room_id),
    inArray(room_shared_artifact_tasks.artifact_identity_key, identityKeys),
  ];

  const links = await db
    .select()
    .from(room_shared_artifact_tasks)
    .where(and(...taskLinkConditions))
    .orderBy(asc(room_shared_artifact_tasks.task_id));

  const taskIdsByArtifact = new Map<string, string[]>();
  for (const link of links) {
    const taskIds = taskIdsByArtifact.get(link.artifact_identity_key) ?? [];
    taskIds.push(link.task_id);
    taskIdsByArtifact.set(link.artifact_identity_key, taskIds);
  }

  return artifactRows
    .filter((artifact) => !input.task_id || taskIdsByArtifact.has(artifact.identity_key))
    .map((artifact) =>
      toRoomSharedArtifact(artifact, taskIdsByArtifact.get(artifact.identity_key) ?? [])
    );
}

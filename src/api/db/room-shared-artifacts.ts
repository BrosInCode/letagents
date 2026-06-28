import { and, asc, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "./client.js";
import { toRoomSharedArtifact, toRoomSharedArtifactTaskLink } from "./mappers.js";
import { room_shared_artifact_tasks, room_shared_artifacts } from "./schema.js";
import type {
  RoomSharedArtifact,
  RoomSharedArtifactSource,
  RoomSharedArtifactTaskLink,
} from "./types.js";
import type { TaskWorkflowArtifact } from "../repo-workflow.js";

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
  if (input.source !== "manual" || !existing) {
    return { artifact, source: input.source };
  }

  return {
    source: existing.source === "manual" ? "manual" : existing.source,
    artifact: {
      provider: artifact.provider,
      kind: artifact.kind,
      id: artifact.id ?? existing.artifact_id ?? undefined,
      number: artifact.number ?? existing.artifact_number ?? undefined,
      title: artifact.title ?? existing.title ?? undefined,
      url: artifact.url ?? existing.url ?? undefined,
      ref: artifact.ref ?? existing.ref ?? undefined,
      state: artifact.state ?? existing.state ?? undefined,
    },
  };
}

export async function upsertRoomSharedArtifact(input: {
  room_id: string;
  artifact: TaskWorkflowArtifact;
  source?: RoomSharedArtifactSource;
}): Promise<RoomSharedArtifact> {
  const now = new Date().toISOString();
  const identityKey = buildRoomSharedArtifactIdentityKey(input.artifact);
  const requestedSource = input.source ?? "task_workflow_artifact";
  const existingArtifact = requestedSource === "manual"
    ? await getRoomSharedArtifactByIdentityKey({
        room_id: input.room_id,
        identity_key: identityKey,
      })
    : null;
  const { artifact, source } = preserveManualRoomSharedArtifactInput({
    artifact: input.artifact,
    source: requestedSource,
    existing: existingArtifact,
  });

  const [row] = await db
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
}): Promise<RoomSharedArtifactTaskLink> {
  const now = new Date().toISOString();
  const source = input.source ?? "task_workflow_artifact";
  const [row] = await db
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

export async function getRoomSharedArtifactByIdentityKey(input: {
  room_id: string;
  identity_key: string;
}): Promise<RoomSharedArtifact | null> {
  const [artifact] = await db
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

  const links = await db
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
}): Promise<RoomSharedArtifact[]> {
  const synced: RoomSharedArtifact[] = [];
  const identityKeys: string[] = [];

  for (const artifact of input.artifacts) {
    const sharedArtifact = await upsertRoomSharedArtifact({
      room_id: input.room_id,
      artifact,
      source: input.source,
    });
    synced.push(sharedArtifact);
    identityKeys.push(sharedArtifact.identity_key);
    await linkRoomSharedArtifactToTask({
      room_id: input.room_id,
      artifact_identity_key: sharedArtifact.identity_key,
      task_id: input.task_id,
      source: input.source,
    });
  }

  const taskLinkConditions = [
    eq(room_shared_artifact_tasks.room_id, input.room_id),
    eq(room_shared_artifact_tasks.task_id, input.task_id),
  ];
  await db
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

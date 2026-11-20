import type { Response } from "express";

import type { Project } from "../db/types.js";

/** The canonical room id a request named, and its room (null once a reply is sent). */
export interface ResolvedRoomRequest {
  roomId: string;
  project: Project | null;
}

export type RoomRequestResolver = (roomId: string, res: Response) => Promise<ResolvedRoomRequest>;

interface TwoStepRoomResolverDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
}

interface RoomRequestResolverDeps extends TwoStepRoomResolverDeps {
  resolveRoomRequestOrReply: RoomRequestResolver;
}

/**
 * The canonical-id-then-resolve pair as a `RoomRequestResolver`, for deps
 * that only have the pair, such as route test doubles.
 */
export function twoStepRoomResolver(deps: TwoStepRoomResolverDeps): RoomRequestResolver {
  return async (roomId, res) => {
    const canonicalRoomId = await deps.resolveCanonicalRoomRequestId(roomId);
    return { roomId: canonicalRoomId, project: await deps.resolveRoomOrReply(canonicalRoomId, res) };
  };
}

/**
 * Resolve a normalized room id from a request path to its canonical id and
 * room, replying 404 or 410 when there is none. The route deps types require
 * `resolveRoomRequestOrReply`, so production wiring cannot leave it out; test
 * doubles, which are not type-checked, may carry only the pair.
 */
export async function resolveRoomRequest(
  deps: RoomRequestResolverDeps,
  roomId: string,
  res: Response
): Promise<ResolvedRoomRequest> {
  const resolve = deps.resolveRoomRequestOrReply ?? twoStepRoomResolver(deps);
  return resolve(roomId, res);
}

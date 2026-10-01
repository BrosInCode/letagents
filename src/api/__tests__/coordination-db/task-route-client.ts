export function buildTaskRouteClient(input: {
  port: number;
  roomId: string;
  ownerToken: string;
}) {
  const roomPath = `/rooms/${encodeURIComponent(input.roomId)}`;
  const jsonHeaders = (token: string) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  });

  const patchTask = (
    taskId: string,
    body: Record<string, unknown>,
    token = input.ownerToken,
  ) =>
    fetch(
      `http://127.0.0.1:${input.port}${roomPath}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      },
    );

  const createTaskViaRoute = (body: Record<string, unknown>, token = input.ownerToken) =>
    fetch(`http://127.0.0.1:${input.port}${roomPath}/tasks`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(body),
    });

  const taskAction = (
    action: "lease-action" | "review-lease-action",
    taskId: string,
    body: Record<string, unknown>,
    auth: { bearerToken?: string; sessionToken?: string } = {
      bearerToken: input.ownerToken,
    },
  ) =>
    fetch(
      `http://127.0.0.1:${input.port}${roomPath}/tasks/${encodeURIComponent(taskId)}/${action}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth.bearerToken
            ? { Authorization: `Bearer ${auth.bearerToken}` }
            : {}),
          ...(auth.sessionToken
            ? { Cookie: `letagents_session=${encodeURIComponent(auth.sessionToken)}` }
            : {}),
        },
        body: JSON.stringify(body),
      },
    );

  type Auth = { bearerToken?: string; sessionToken?: string };
  const leaseAction = (taskId: string, body: Record<string, unknown>, auth?: Auth) =>
    taskAction("lease-action", taskId, body, auth);
  const reviewLeaseAction = (taskId: string, body: Record<string, unknown>, auth?: Auth) =>
    taskAction("review-lease-action", taskId, body, auth);

  return { createTaskViaRoute, leaseAction, patchTask, reviewLeaseAction };
}

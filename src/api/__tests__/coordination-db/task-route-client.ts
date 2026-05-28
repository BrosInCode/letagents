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

  const leaseAction = (
    taskId: string,
    body: Record<string, unknown>,
    auth: { bearerToken?: string; sessionToken?: string } = {
      bearerToken: input.ownerToken,
    },
  ) =>
    fetch(
      `http://127.0.0.1:${input.port}${roomPath}/tasks/${encodeURIComponent(taskId)}/lease-action`,
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

  return { createTaskViaRoute, leaseAction, patchTask };
}

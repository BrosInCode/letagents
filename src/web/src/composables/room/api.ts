export async function apiFetch(
  path: string,
  options?: RequestInit,
): Promise<any> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const rawBody = await res.text().catch(() => '')
    let payload: any = null
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody)
      } catch {
        payload = null
      }
    }
    const error = new Error(
      payload?.message || payload?.error || rawBody || `HTTP ${res.status}`,
    ) as Error & {
      status?: number
      code?: string | null
      payload?: any
    }
    error.status = res.status
    error.code = payload?.code || payload?.error || null
    error.payload = payload
    throw error
  }
  return res.json()
}

export function roomPath(identifier: string): string {
  return `/rooms/${encodeURIComponent(identifier)}`
}

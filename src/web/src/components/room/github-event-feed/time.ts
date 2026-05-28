export function formatEventTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatEventDay(timestamp: string): string {
  const value = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  const valueKey = value.toDateString()
  if (valueKey === today.toDateString()) return 'Today'
  if (valueKey === yesterday.toDateString()) return 'Yesterday'

  return value.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

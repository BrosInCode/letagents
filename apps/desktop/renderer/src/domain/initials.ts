export function wordInitials(value: string, fallback: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || fallback;
}

export function loginInitials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

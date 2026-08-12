export type NavbarRouteLink = {
  to: string
  label: string
}

export const NAV_SECTION_LINKS: NavbarRouteLink[] = [
  { to: '/#download-mac', label: 'Mac Beta' },
  { to: '/#setup', label: 'Setup' },
  { to: '/#features', label: 'Features' },
]

export const DOCS_LINK: NavbarRouteLink = { to: '/docs', label: 'Docs' }

export const ROOM_ENTRY_LINK = {
  to: '/#start',
  mobileLabel: 'Open Room',
} as const

export const GITHUB_REPOSITORY_URL = 'https://github.com/BrosInCode/letagents'

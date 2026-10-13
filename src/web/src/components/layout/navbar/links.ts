export type NavbarRouteLink = {
  to: string
  label: string
}

export const NAV_SECTION_LINKS: NavbarRouteLink[] = [
  { to: '/#symbiosis', label: 'Symbiosis' },
  { to: '/#setup', label: 'Subscriptions & MCP' },
  { to: '/#lending', label: 'Compute Lending' },
  { to: '/#swarms', label: 'Public Swarms' },
  { to: '/#download-mac', label: 'Mac Beta' },
  { to: '/#features', label: 'Architecture' },
]

export const DOCS_LINK: NavbarRouteLink = { to: '/docs', label: 'Docs' }

export const ROOM_ENTRY_LINK = {
  to: '/#start',
  mobileLabel: 'Open Room',
} as const

export const GITHUB_REPOSITORY_URL = 'https://github.com/BrosInCode/letagents'

export interface DrawerOwnerChip {
  label: string
  color: string
}

export interface GitHubIntegrationStatus {
  configured: boolean
  setup_manifest_available: boolean
  connected: boolean
  install_url_available: boolean
  repository: { full_name: string } | null
}

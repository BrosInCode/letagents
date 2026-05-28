const eventTypeLabels: Record<string, string> = {
  pull_request: 'Pull requests',
  pull_request_review: 'Reviews',
  issue: 'Issues',
  issue_comment: 'Comments',
  check_run: 'Checks',
  repository: 'Repository',
  installation: 'Installations',
  installation_repositories: 'Repo access',
}

export function labelForType(value: string): string {
  return eventTypeLabels[value] || value.replace(/_/g, ' ')
}

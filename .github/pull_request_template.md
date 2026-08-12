## Verification

- [ ] Tests and checks relevant to this change pass.
- [ ] If this PR changes supervisor-daemon behavior, both `DAEMON_IMPLEMENTATION_VERSION` and `SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION` were bumped together; otherwise, this item is not applicable.

The implementation version is the deployment fence between the desktop and the detached daemon. Reviewers must reject daemon-behavior changes that leave it unchanged, because an older same-version process would otherwise be accepted as current instead of performing a negotiated handoff.

# Sourced by the existing watchdog after NTFY_URL and STATE_DIR are defined.
# Keep the room identifier and alert destination out of logs.
check_letagents() {
    local state_file="$STATE_DIR/letagents" prev state result attempt temp
    local probe="${LETAGENTS_PROBE:-/usr/local/bin/letagents-probe.py}"
    local config="${LETAGENTS_MONITOR_CONFIG:-/etc/letagents-monitor.json}"
    prev=$(cat "$state_file" 2>/dev/null || echo up)
    state=down
    for attempt in 1 2; do
        # urllib socket timeouts alone cannot bound a trickling response.
        if result=$(timeout --kill-after=2s 30s "$probe" --config "$config" 2>/dev/null); then
            state=up
            printf 'LetAgents message probe: %s\n' "$result"
            break
        fi
        printf 'LetAgents message probe failed (attempt %s): %s\n' "$attempt" "$result"
        if [ "$attempt" = 1 ]; then sleep 10; fi
    done
    if [ "$state" != "$prev" ]; then
        local title message priority
        if [ "$state" = up ]; then
            title='RECOVERED: LetAgents message delivery'
            message='LetAgents accepted a test message, delivered it over a live stream, and returned it from saved history.'
            priority=default
        else
            title='DOWN: LetAgents message delivery'
            message='The LetAgents message probe failed twice. The homepage may still load; check API, database, and streaming delivery. See the uptime-watchdog journal for the failed stage.'
            priority=urgent
        fi
        if ! curl --fail --silent --show-error --max-time 10 -o /dev/null \
            -H "Title: $title" -H "Priority: $priority" -d "$message" "$NTFY_URL"; then
            # Retry notification on the next scheduled run, instead of silently
            # acknowledging a transition whose notification was never accepted.
            printf 'LetAgents alert delivery failed; transition remains pending.\n' >&2
            return 1
        fi
    fi
    temp=$(mktemp "$STATE_DIR/.letagents.XXXXXX") || return 1
    if ! printf '%s\n' "$state" > "$temp" || ! mv "$temp" "$state_file"; then
        rm -f "$temp"
        return 1
    fi
    [ "$state" = up ]
}

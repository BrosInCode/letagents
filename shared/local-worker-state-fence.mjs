import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';

/** Remote MCP board requests retain their exact registered connection fence. */
export function withRegisteredWorkerStateFence(statePath, supplied, callback) {
    if (typeof statePath !== "string" || !isAbsolute(statePath)
        || !supplied || typeof supplied.session_token !== "string"
        || ![supplied.agent_instance_id, supplied.session_id, supplied.agent_key, supplied.room_id]
            .every(value => typeof value === "string" && value.trim())) {
        throw new Error("Register this MCP worker before changing the local board.");
    }
    return withStateFileLock(statePath, () => {
        let state;
        try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = null; }
        const current = state?.agent_sessions?.[supplied.session_id];
        if (!current || current.ended_at || current.session_token !== supplied.session_token
            || current.agent_instance_id !== supplied.agent_instance_id || current.room_id !== supplied.room_id
            || current.agent_key !== supplied.agent_key
            || state?.mcp_workers?.[current.agent_instance_id]?.rooms?.[current.room_id]?.pending) {
            throw new Error("Local worker authority ended or this connection was replaced. Reconnect explicitly with its worker_id.");
        }
        return callback(current);
    });
}
const STATE_LOCK_WAIT_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { if (ms > 0)
    Atomics.wait(STATE_LOCK_SLEEP_BUFFER, 0, 0, ms); }
export function withStateFileLock(statePath, callback) {
    mkdirSync(dirname(statePath), { recursive: true });
    const lockPath = `${statePath}.lock`;
    const startedAt = Date.now();
    while (true) {
        let lockFd = null;
        try {
            lockFd = openSync(lockPath, "wx");
            return callback(statePath);
        }
        catch (error) {
            const err = error;
            if (err.code !== "EEXIST") {
                throw error;
            }
            try {
                const stats = statSync(lockPath);
                if (Date.now() - stats.mtimeMs > STATE_LOCK_STALE_MS) {
                    rmSync(lockPath, { force: true });
                    continue;
                }
            }
            catch {
                continue;
            }
            if (Date.now() - startedAt >= STATE_LOCK_TIMEOUT_MS) {
                throw new Error(`Timed out acquiring local state lock at ${lockPath}`);
            }
            sleepSync(STATE_LOCK_WAIT_MS);
        }
        finally {
            if (lockFd !== null) {
                closeSync(lockFd);
                rmSync(lockPath, { force: true });
            }
        }
    }
}

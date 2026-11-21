//! `manifest.watch_state`, ported from `daemon-state-watch.ts` and
//! `ManifestStore.loadForStateWatch`: one sequence that each change moves,
//! waiters woken after a 150 ms coalescing window, one snapshot at a time,
//! a per-agent entry cache keyed on `agent_state_versions.manifest_version`,
//! and changed-entry tracking for `changed_only`.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::manifest::{self, Activity, Reads};
use crate::Daemon;

pub const COALESCE_MS: u64 = 150; // STATE_WATCH_NOTIFICATION_COALESCE_MS

pub struct Input {
    pub after_generation: i64,
    pub after_sequence: i64,
    pub wait_ms: u64,
    pub changed_only: bool,
}

struct Signal {
    sequence: i64,
    coalescing: bool,
    waiters: usize,
}

#[derive(Default)]
struct Tracked {
    built: bool,
    sequence: i64,
    since: i64,
    order: Vec<String>,
    entries: Vec<Arc<Value>>,
    cache: HashMap<String, (i64, Arc<Value>)>,
    changed_at: HashMap<String, i64>,
    removed_at: HashMap<String, i64>,
}

pub struct StateWatch {
    generation: i64,
    signal: Arc<(Mutex<Signal>, Condvar)>,
    tracked: Mutex<Tracked>,
}

impl StateWatch {
    pub fn new(generation: i64) -> Self {
        Self {
            generation,
            signal: Arc::new((Mutex::new(Signal { sequence: 1, coalescing: false, waiters: 0 }), Condvar::new())),
            tracked: Mutex::new(Tracked::default()),
        }
    }

    pub fn notify(&self) {
        let (lock, condvar) = &*self.signal;
        let mut signal = lock.lock().unwrap();
        signal.sequence += 1;
        if signal.coalescing || signal.waiters == 0 {
            return;
        }
        signal.coalescing = true;
        let shared = self.signal.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(COALESCE_MS));
            let (lock, condvar) = &*shared;
            lock.lock().unwrap().coalescing = false;
            condvar.notify_all();
        });
        drop(signal);
        let _ = condvar;
    }

    /// The result as JSON text, so the shared entries are written, not copied.
    pub fn watch(&self, daemon: &Daemon, input: Input) -> Result<String, String> {
        {
            let (lock, condvar) = &*self.signal;
            let mut signal = lock.lock().unwrap();
            if input.after_generation == self.generation && input.after_sequence >= signal.sequence && input.wait_ms > 0 {
                signal.waiters += 1;
                let deadline = Instant::now() + Duration::from_millis(input.wait_ms);
                while input.after_sequence >= signal.sequence || signal.coalescing {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    signal = condvar.wait_timeout(signal, deadline - now).unwrap().0;
                }
                signal.waiters -= 1;
            }
        }
        let mut tracked = self.tracked.lock().unwrap();
        let sequence = self.signal.0.lock().unwrap().sequence;
        if !tracked.built || tracked.sequence < sequence {
            self.rebuild(daemon, &mut tracked, sequence)?;
        }
        Ok(self.render(&tracked, &input))
    }

    fn rebuild(&self, daemon: &Daemon, tracked: &mut Tracked, sequence: i64) -> Result<(), String> {
        let db = daemon.db.lock().unwrap();
        let e = |error: rusqlite::Error| error.to_string();
        // Versions before rows: an entry kept under a version was projected after it was read.
        let mut versions = HashMap::new();
        for row in manifest::rows(&mut db.prepare(manifest::MANIFEST_VERSIONS).map_err(e)?, []).map_err(e)? {
            versions.insert(row_string(&row, 0), row_i64(&row, 1));
        }
        let ids: Vec<String> = manifest::rows(&mut db.prepare(manifest::ENTRY_IDS).map_err(e)?, [])
            .map_err(e)?
            .iter()
            .map(|row| row_string(row, 0))
            .collect();
        let mut reads = Reads::new(&db).map_err(e)?;
        let mut entry_statement = db.prepare(&manifest::entry_sql()).map_err(e)?;
        let mut cache = HashMap::with_capacity(ids.len());
        let mut entries = Vec::with_capacity(ids.len());
        let mut order = Vec::with_capacity(ids.len());
        for id in ids {
            let version = versions.get(&id).copied().unwrap_or(0);
            let entry = match tracked.cache.get(&id) {
                Some((kept, entry)) if *kept == version => entry.clone(),
                _ => {
                    let rows = manifest::rows(&mut entry_statement, [&id]).map_err(e)?;
                    let Some(row) = rows.first() else { continue };
                    Arc::new(reads.entry(row, Activity::Summary).map_err(e)?)
                }
            };
            cache.insert(id.clone(), (version, entry.clone()));
            entries.push(entry);
            order.push(id);
        }
        drop(entry_statement);
        drop(reads);
        drop(db);

        // `track`: an entry changed when its value differs from the last snapshot's.
        let first = !tracked.built;
        let mut changed_at = HashMap::with_capacity(order.len());
        for (id, entry) in order.iter().zip(&entries) {
            let same = tracked.cache.get(id).map(|(_, before)| Arc::ptr_eq(before, entry) || **before == **entry).unwrap_or(false);
            let at = if same && !first { tracked.changed_at.get(id).copied().unwrap_or(sequence) } else { sequence };
            changed_at.insert(id.clone(), at);
        }
        let mut removed_at = std::mem::take(&mut tracked.removed_at);
        for id in tracked.order.iter() {
            if !cache.contains_key(id) {
                removed_at.insert(id.clone(), sequence);
            }
        }
        removed_at.retain(|id, _| !cache.contains_key(id));
        *tracked = Tracked {
            built: true,
            sequence,
            since: if first { sequence } else { tracked.since },
            order,
            entries,
            cache,
            changed_at,
            removed_at,
        };
        Ok(())
    }

    fn render(&self, tracked: &Tracked, input: &Input) -> String {
        let mut out = String::with_capacity(1 << 20);
        let changes = input.changed_only
            && input.after_generation == self.generation
            && input.after_sequence >= tracked.since
            && input.after_sequence <= tracked.sequence;
        out.push_str(&format!("{{\"daemon_generation\":{},\"sequence\":{}", self.generation, tracked.sequence));
        if changes {
            out.push_str(",\"complete\":false");
        }
        out.push_str(",\"entries\":[");
        let mut first = true;
        for (id, entry) in tracked.order.iter().zip(&tracked.entries) {
            if changes && tracked.changed_at.get(id).copied().unwrap_or(i64::MAX) <= input.after_sequence {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&serde_json::to_string(&**entry).unwrap_or_default());
        }
        out.push(']');
        if changes {
            let removed: Vec<&String> =
                tracked.removed_at.iter().filter(|(_, at)| **at > input.after_sequence).map(|(id, _)| id).collect();
            out.push_str(&format!(",\"removed_entry_ids\":{}", serde_json::to_string(&removed).unwrap()));
            out.push_str(&format!(",\"entry_order\":{}", serde_json::to_string(&tracked.order).unwrap()));
        }
        out.push('}');
        out
    }
}

fn row_string(row: &manifest::Row, index: usize) -> String {
    row.value(index).as_str().map(str::to_owned).unwrap_or_else(|| row.value(index).to_string())
}

fn row_i64(row: &manifest::Row, index: usize) -> i64 {
    row.value(index).as_i64().unwrap_or(0)
}

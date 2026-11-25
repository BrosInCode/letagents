//! Spike only. A Rust stand-in for the LetAgents supervisor daemon that serves
//! five control methods over the same Unix socket, with the same singleton
//! lock, from the same SQLite file:
//!
//! - `daemon.negotiate`, `daemon.status`
//! - `manifest.list` (the stored entry, not the derived view; see manifest.rs)
//! - `manifest.watch_state` (long poll, 150 ms coalescing, `changed_only`)
//! - `manifest.update_workplace_liveness` (one write, so a watch has changes)
//!
//! It starts no provider, talks to no server and is not shipped. It exists to
//! measure, see docs/plans/daemon-rust-evaluation.md.

mod avatar;
mod manifest;
mod watch;

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};

use manifest::{Activity, Reads};

const PROTOCOL_VERSION: i64 = 3;
const SCHEMA_VERSION: i64 = 52; // DAEMON_STATE_SCHEMA_VERSION on staging
const IMPLEMENTATION_VERSION: &str = "2.0.284-rust-spike";
const MAX_FRAME_BYTES: usize = 64 * 1024;

static SOCKET_PATH: OnceLock<CString> = OnceLock::new();

enum Reply {
    Json(Value),
    /// A result that is already JSON text (the state watch writes shared entries).
    Raw(String),
}

pub struct Daemon {
    db: Mutex<Connection>,
    generation: i64,
    started_at: String,
    watch: watch::StateWatch,
}

fn now_iso() -> String {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso_from_ms(elapsed.as_millis() as i64)
}

/// `new Date(ms).toISOString()`.
pub fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// `SupervisorSingleton.acquire` on macOS: `O_EXLOCK | O_NONBLOCK`, then a
/// durable generation counter written with temp file, fsync, rename, dir fsync.
fn acquire_singleton(state_dir: &Path) -> std::io::Result<(File, i64)> {
    fs::create_dir_all(state_dir)?;
    fs::set_permissions(state_dir, fs::Permissions::from_mode(0o700))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NONBLOCK | libc::O_EXLOCK)
        .open(state_dir.join("daemon.lock"))
        .map_err(|error| {
            if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
                std::io::Error::new(ErrorKind::AddrInUse, "A supervisor daemon already owns this host lock.")
            } else {
                error
            }
        })?;
    let generation_path = state_dir.join("daemon.lock.generation");
    let prior = match fs::read_to_string(&generation_path) {
        Ok(raw) => raw.trim().parse::<i64>().map_err(|_| {
            std::io::Error::new(ErrorKind::InvalidData, "Supervisor generation state is malformed; refusing to roll back fencing.")
        })?,
        Err(error) if error.kind() == ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    let generation = prior + 1;
    let temporary = state_dir.join(format!("daemon.lock.generation.{}.tmp", std::process::id()));
    {
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?;
        file.write_all(format!("{generation}\n").as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&temporary, &generation_path)?;
    File::open(state_dir)?.sync_all()?;
    Ok((lock, generation))
}

/// `openDaemonStateDatabase` pragmas plus the first check of `version-gate.ts`.
/// The spike refuses any other schema version; it migrates nothing.
fn open_database(path: &Path) -> Result<Connection, String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA temp_store = MEMORY; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;",
    )
    .map_err(|e| e.to_string())?;
    let journal: String = db.query_row("PRAGMA journal_mode", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if journal.to_lowercase() != "wal" {
        return Err(format!("Daemon state database must use WAL, found {journal}."));
    }
    let user_version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let stored: i64 = db
        .query_row("SELECT schema_version FROM manifest_metadata WHERE singleton = 1", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if user_version != SCHEMA_VERSION || stored != SCHEMA_VERSION {
        return Err(format!("Spike reads schema {SCHEMA_VERSION} only; found user_version {user_version}, stored {stored}."));
    }
    Ok(db)
}

impl Daemon {
    fn status(&self) -> Value {
        let env = |name: &str| std::env::var(name).map(Value::String).unwrap_or(Value::Null);
        json!({
            "healthy": true,
            "protocol_version": PROTOCOL_VERSION,
            "implementation_version": IMPLEMENTATION_VERSION,
            "runtime_environment_fingerprint": env("LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT"),
            "compatibility_fingerprint": env("LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT"),
            // The spike can deliver nothing, so it offers no delivery capability.
            "capabilities": {
                "room_delivery_retry": false,
                "provider_continuation_repair": false,
                "room_delivery_skip": false,
                "agent_inspector_detail_v1": false,
                "agent_inspector_settings_v1": false,
                "agent_room_move_v1": false,
                "agent_lifecycle_v1": false,
                "agent_runtime_recovery_v1": false,
                "agent_runtime_recovery_v2": false,
                "agent_state_subscription_v1": true,
                "agent_activity_stream_v1": false,
                "custodialPollingV1": false,
                "custodialPollingOffersV1": false
            },
            "generation": self.generation,
            "pid": std::process::id(),
            "started_at": self.started_at,
            "recovery_diagnostics": [],
            "maintenance_hold_id": null
        })
    }

    pub fn list(&self, room_id: Option<&str>, mode: Activity) -> Result<Value, String> {
        let db = self.db.lock().unwrap();
        let mut reads = Reads::new(&db).map_err(|e| e.to_string())?;
        let rows = match room_id {
            Some(room) => manifest::rows(&mut db.prepare(&manifest::room_entries_sql()).map_err(|e| e.to_string())?, [room]),
            None => manifest::rows(&mut db.prepare(&manifest::all_entries_sql()).map_err(|e| e.to_string())?, []),
        }
        .map_err(|e| e.to_string())?;
        let mut entries = Vec::with_capacity(rows.len());
        for row in &rows {
            entries.push(reads.entry(row, mode).map_err(|e| e.to_string())?);
        }
        Ok(Value::Array(entries))
    }

    fn update_workplace_liveness(&self, params: &Map<String, Value>) -> Result<Value, String> {
        let id = params.get("id").and_then(Value::as_str).unwrap_or("");
        let state = params.get("state").and_then(Value::as_str).unwrap_or("unknown");
        let detail = params.get("detail").and_then(Value::as_str);
        let observed_at = params.get("observed_at").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(now_iso);
        if id.is_empty() {
            return Err("Manifest entry id is required.".into());
        }
        if !matches!(state, "reachable" | "stale" | "unknown") {
            return Err("Invalid workplace liveness state.".into());
        }
        let entry = {
            let mut db = self.db.lock().unwrap();
            // `ManifestStore.writeTargeted`: one IMMEDIATE transaction that moves the generation.
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            tx.execute("UPDATE manifest_metadata SET generation = generation + 1 WHERE singleton = 1", [])
                .map_err(|e| e.to_string())?;
            let changed = tx
                .execute(
                    "UPDATE runtime_deployments SET workplace_liveness_present = 1, workplace_liveness_state = ?,
                       workplace_liveness_observed_at = ?, workplace_liveness_detail = ? WHERE agent_id = ?",
                    rusqlite::params![state, observed_at, detail, id],
                )
                .map_err(|e| e.to_string())?;
            if changed != 1 {
                return Err(format!("Unknown daemon manifest entry: {id}"));
            }
            let entry = {
                let mut reads = Reads::new(&tx).map_err(|e| e.to_string())?;
                let rows = manifest::rows(&mut tx.prepare(&manifest::entry_sql()).map_err(|e| e.to_string())?, [id])
                    .map_err(|e| e.to_string())?;
                let row = rows.first().ok_or_else(|| format!("Daemon manifest entry disappeared during liveness update: {id}"))?;
                reads.entry(row, Activity::Full).map_err(|e| e.to_string())?
            };
            tx.commit().map_err(|e| e.to_string())?;
            entry
        };
        self.watch.notify();
        Ok(entry)
    }

    fn handle(&self, request: &Value) -> Result<Reply, String> {
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let empty = Map::new();
        let params = request.get("params").and_then(Value::as_object).unwrap_or(&empty);
        match method {
            "daemon.negotiate" | "daemon.status" => Ok(Reply::Json(self.status())),
            "manifest.list" => {
                let room = match params.get("room_id") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(room)) if !room.trim().is_empty() && room.trim() == room => Some(room.as_str()),
                    _ => return Err("manifest.list room_id must be an exact non-empty room identifier.".into()),
                };
                let mode = match params.get("activity") {
                    None | Some(Value::Null) => Activity::Full,
                    Some(Value::String(mode)) if mode == "full" => Activity::Full,
                    Some(Value::String(mode)) if mode == "summary" => Activity::Summary,
                    _ => return Err("manifest.list activity must be \"full\" or \"summary\".".into()),
                };
                self.list(room, mode).map(Reply::Json)
            }
            "manifest.watch_state" => {
                let number = |key: &str, default: f64| params.get(key).and_then(Value::as_f64).unwrap_or(default);
                self.watch.watch(
                    self,
                    watch::Input {
                        after_generation: number("after_daemon_generation", 0.0) as i64,
                        after_sequence: number("after_sequence", 0.0) as i64,
                        wait_ms: number("wait_ms", 25_000.0).clamp(0.0, 30_000.0) as u64,
                        changed_only: params.get("changed_only") == Some(&Value::Bool(true)),
                    },
                )
                .map(Reply::Raw)
            }
            "manifest.update_workplace_liveness" => self.update_workplace_liveness(params).map(Reply::Json),
            other => Err(format!("Unsupported daemon method in the Rust spike: {other}")),
        }
    }

    fn respond(&self, line: &str) -> Vec<u8> {
        let parsed: Result<Value, _> = serde_json::from_str(line);
        let id = parsed.as_ref().ok().and_then(|r| r.get("id").cloned());
        let outcome = match &parsed {
            Err(_) => Err("Invalid daemon request.".to_string()),
            Ok(request) => {
                let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                if line.len() >= MAX_FRAME_BYTES {
                    Err("Daemon request is too large.".into())
                } else if request.get("version").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) && method != "daemon.negotiate" {
                    Err(format!(
                        "Protocol version mismatch: expected {PROTOCOL_VERSION}, received {}.",
                        request.get("version").map(|v| v.to_string()).unwrap_or_else(|| "undefined".into())
                    ))
                } else {
                    self.handle(request)
                }
            }
        };
        if let Ok(Reply::Raw(result)) = &outcome {
            let id = id.map(|id| format!(",\"id\":{id}")).unwrap_or_default();
            return format!("{{\"version\":{PROTOCOL_VERSION}{id},\"ok\":true,\"result\":{result}}}\n").into_bytes();
        }
        let mut response = Map::new();
        response.insert("version".into(), json!(PROTOCOL_VERSION));
        if let Some(id) = id {
            response.insert("id".into(), id);
        }
        match outcome {
            Ok(Reply::Raw(_)) => unreachable!(),
            Ok(Reply::Json(result)) => {
                response.insert("ok".into(), Value::Bool(true));
                response.insert("result".into(), result);
            }
            Err(error) => {
                response.insert("ok".into(), Value::Bool(false));
                response.insert("error".into(), Value::String(error));
            }
        }
        let mut bytes = serde_json::to_vec(&Value::Object(response)).unwrap_or_default();
        bytes.push(b'\n');
        bytes
    }
}

fn serve(daemon: Arc<Daemon>, stream: UnixStream) {
    let mut writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        // A frame over the cap closes the connection, as control-socket.ts does.
        let read = match (&mut reader).take(MAX_FRAME_BYTES as u64 + 1).read_line(&mut line) {
            Ok(read) => read,
            Err(_) => return,
        };
        if read == 0 || (!line.ends_with('\n') && line.len() > MAX_FRAME_BYTES) {
            return;
        }
        let response = daemon.respond(line.trim_end_matches('\n'));
        if writer.write_all(&response).is_err() {
            return;
        }
    }
}

extern "C" fn on_terminate(_: libc::c_int) {
    if let Some(path) = SOCKET_PATH.get() {
        unsafe { libc::unlink(path.as_ptr()) };
    }
    unsafe { libc::_exit(0) };
}

fn main() {
    let boot = Instant::now();
    let state_dir: PathBuf = std::env::args()
        .skip_while(|a| a != "--state-dir")
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").expect("HOME is required")).join(".letagents"));

    let (_lock, generation) = acquire_singleton(&state_dir).unwrap_or_else(|error| {
        eprintln!("Supervisor daemon failed: {error}");
        std::process::exit(1);
    });
    let db = open_database(&state_dir.join("daemon-state.sqlite")).unwrap_or_else(|error| {
        eprintln!("Supervisor daemon failed: {error}");
        std::process::exit(1);
    });
    let daemon = Arc::new(Daemon { db: Mutex::new(db), generation, started_at: now_iso(), watch: watch::StateWatch::new(generation) });

    let socket_path = state_dir.join("daemon.sock");
    let _ = fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap_or_else(|error| {
        eprintln!("Supervisor daemon failed: {error}");
        std::process::exit(1);
    });
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)).expect("chmod socket");
    let _ = SOCKET_PATH.set(CString::new(socket_path.as_os_str().as_encoded_bytes()).unwrap());
    unsafe {
        libc::signal(libc::SIGTERM, on_terminate as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_terminate as libc::sighandler_t);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    eprintln!("{{\"event\":\"daemon_ready\",\"generation\":{generation},\"ms\":{}}}", boot.elapsed().as_millis());

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let daemon = daemon.clone();
                std::thread::spawn(move || serve(daemon, stream));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

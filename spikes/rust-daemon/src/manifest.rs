//! The manifest read, ported from `apps/desktop/daemon/manifest-store/`:
//! `MANIFEST_ENTRY_SELECT` and `MANIFEST_READS` (shared.ts), `projectionFromRow`
//! and `terminalFromRow` (projections.ts), and `composeDaemonManifestEntry`
//! (manifest-entry-projection.ts). It gives the stored entry only. The view that
//! `manifest.list` sends (`entriesWithDerivedLiveness`) also needs live
//! in-memory daemon state, and the spike does not have that state.

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, Statement};
use serde_json::{Map, Number, Value};

use crate::avatar;

pub const SUMMARY_ACTIVITY_LIMIT: i64 = 16; // STATE_WATCH_ACTIVITY_SUMMARY_LIMIT
pub const MAX_COMPLETED_ACTION_IDS: i64 = 32; // MAX_PROJECTED_COMPLETED_ACTION_IDS

const ENTRY_SELECT: &str = r#"
      SELECT
        i.agent_id, i.created_by, i.created_at,
        p.display_name, p.avatar_json, m.room_id, m.local_room_id,
        c.provider, c.model, c.reasoning_effort, c.charter, c.permission_profile_id, c.config_revision, c.runtime_configuration_revision, c.delivery_mode, c.delivery_cutover_json,
        c.provider_launch_policy_present, c.provider_launch_policy_undefined, c.provider_launch_policy_json,
        l.desired_state, l.source_repo_path_present, l.source_repo_path,
        d.deployment_id, d.run_id, d.observed_state,
        d.workspace_path_present, d.workspace_path,
        d.work_attempt_id_present, d.work_attempt_id,
        d.provider_ref_present, d.provider_work_attempt_id, d.provider_continuation_id,
        d.provider_connection_kind, d.provider_connection_url, d.provider_server_auth_path,
        d.provider_connection_pid,
        d.provider_process_identity_present,
        d.provider_process_identity, d.provider_execution_generation_id, d.custodial_launch_agent_session_id,
        d.workplace_liveness_present, d.workplace_liveness_state,
        d.workplace_liveness_observed_at, d.workplace_liveness_detail,
        d.native_liveness_present, d.native_liveness_state,
        d.native_liveness_observed_at, d.native_liveness_detail,
        d.activity_present,
        s.condition, s.last_error_present, s.last_error,
        r.ready_reached_at_present, r.ready_reached_at,
        COALESCE(w.last_sequence,0) AS last_turn_control_sequence,
        t.turn_control_present, t.action_id, t.action_sequence, t.turn_work_attempt_id,
        t.turn_execution_generation_id, t.target_room_id, t.target_source_message_id,
        t.target_provider_continuation_id, t.has_correction, t.status AS turn_status,
        t.inbox_item_id, t.provider_turn_id, t.correction_text, t.correction_strategy, t.operator_resolution,
        t.capability, t.interrupted, t.resumed, t.turn_state, t.error AS turn_error,
        t.recorded_at, t.updated_at,
        b.last_worker_binding_present, b.binding_agent_session_id,
        b.binding_work_attempt_id, b.binding_execution_generation_id, b.binding_updated_at,
        q.reconciliation_present, q.consecutive_action_failures,
        q.last_observed_state, q.next_restart_at_ms, q.last_action_sequence,
        q.pending_action_id, q.pending_action_sequence, q.pending_action_kind,
        q.pending_action_recorded_at_ms, q.last_terminal_present,
        q.terminal_ended_at, q.terminal_exit_code, q.terminal_signal,
        q.terminal_stdio_archive_ref, q.terminal_stdio_tail, q.terminal_cause,
        q.terminal_actor, q.terminal_generation, q.terminal_provider_continuation_id,
        q.reconciliation_notices_present
      FROM agent_identities i
      JOIN agent_profiles p USING (agent_id)
      JOIN agent_room_memberships m USING (agent_id)
      JOIN agent_configurations c USING (agent_id)
      JOIN agent_launch_intents l USING (agent_id)
      JOIN runtime_deployments d USING (agent_id)
      JOIN agent_lifecycle_states s USING (agent_id)
      JOIN agent_readiness r USING (agent_id)
      JOIN turn_control_journals t USING (agent_id)
      LEFT JOIN turn_control_sequence_watermarks w USING (agent_id)
      JOIN retained_worker_bindings b USING (agent_id)
      JOIN reconciliation_records q USING (agent_id)
"#;

pub const ENTRY_IDS: &str = "SELECT agent_id FROM agent_identities ORDER BY sort_order";
pub const MANIFEST_VERSIONS: &str = "SELECT agent_id, manifest_version FROM agent_state_versions";
const ACTIVITY_FULL: &str = "SELECT * FROM activity_events WHERE agent_id = ? ORDER BY sort_order";
const ACTIVITY_SUMMARY: &str = "SELECT observed_at, sequence, provider, kind, method, summary, status,
    NULL AS payload_json, payload_truncated, payload_redacted, durable_payload_ref
    FROM activity_events WHERE agent_id = ? ORDER BY sequence DESC, sort_order DESC LIMIT ?";
const STAGES: &str = "SELECT stage FROM turn_control_stages WHERE agent_id = ? ORDER BY sort_order";
const COMPLETED_ACTIONS: &str = "SELECT action_id FROM reconciliation_completed_actions
    WHERE agent_id = ? ORDER BY sort_order DESC LIMIT ?";
const EXIT_TIMESTAMPS: &str = "SELECT timestamp_ms FROM reconciliation_exit_timestamps WHERE agent_id = ? ORDER BY sort_order";
const NOTICES: &str = "SELECT * FROM reconciliation_notices WHERE agent_id = ? ORDER BY sort_order";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Full,
    Summary,
}

pub fn all_entries_sql() -> String {
    format!("{ENTRY_SELECT} ORDER BY i.sort_order")
}
pub fn room_entries_sql() -> String {
    format!("{ENTRY_SELECT} WHERE m.room_id = ? ORDER BY i.sort_order")
}
pub fn entry_sql() -> String {
    format!("{ENTRY_SELECT} WHERE i.agent_id = ?")
}

/// One row with its columns by name, read as `node:sqlite` returns values.
pub struct Row {
    names: Arc<HashMap<String, usize>>,
    values: Vec<Sql>,
}

impl Row {
    /// A column by position, as JSON.
    pub fn value(&self, index: usize) -> Value {
        match &self.values[index] {
            Sql::Null => Value::Null,
            Sql::Integer(i) => Value::from(*i),
            Sql::Real(f) => js_number(&Sql::Real(*f)),
            Sql::Text(t) => Value::String(t.clone()),
            Sql::Blob(_) => Value::Null,
        }
    }
    fn get(&self, name: &str) -> &Sql {
        static NULL: Sql = Sql::Null;
        self.names.get(name).map(|i| &self.values[*i]).unwrap_or(&NULL)
    }
    /// JavaScript `String(value)`.
    fn s(&self, name: &str) -> Value {
        Value::String(js_string(self.get(name)))
    }
    /// `nullableString`.
    fn ns(&self, name: &str) -> Value {
        match self.get(name) {
            Sql::Null => Value::Null,
            other => Value::String(js_string(other)),
        }
    }
    /// JavaScript `Number(value)`.
    fn n(&self, name: &str) -> Value {
        js_number(self.get(name))
    }
    /// `nullableNumber`.
    fn nn(&self, name: &str) -> Value {
        match self.get(name) {
            Sql::Null => Value::Null,
            other => js_number(other),
        }
    }
    /// `bool`: `Number(value) === 1`.
    fn b(&self, name: &str) -> bool {
        match self.get(name) {
            Sql::Integer(i) => *i == 1,
            Sql::Real(f) => *f == 1.0,
            Sql::Text(t) => t.trim().parse::<f64>().map(|f| f == 1.0).unwrap_or(false),
            _ => false,
        }
    }
    fn is_null(&self, name: &str) -> bool {
        matches!(self.get(name), Sql::Null)
    }
    /// JavaScript truthiness of the nullable string.
    fn truthy(&self, name: &str) -> bool {
        match self.get(name) {
            Sql::Null => false,
            other => !js_string(other).is_empty(),
        }
    }
}

fn js_string(value: &Sql) -> String {
    match value {
        Sql::Null => "null".into(),
        Sql::Integer(i) => i.to_string(),
        Sql::Real(f) => js_number(&Sql::Real(*f)).to_string(),
        Sql::Text(t) => t.clone(),
        Sql::Blob(_) => String::new(),
    }
}

fn js_number(value: &Sql) -> Value {
    let float = match value {
        Sql::Null => return Value::from(0),
        Sql::Integer(i) => return Value::from(*i),
        Sql::Real(f) => *f,
        Sql::Text(t) => {
            let t = t.trim();
            if t.is_empty() { 0.0 } else { t.parse::<f64>().unwrap_or(f64::NAN) }
        }
        Sql::Blob(_) => f64::NAN,
    };
    // JSON.stringify writes an integral number with no fraction, and NaN as null.
    if float.fract() == 0.0 && float.abs() < 9_007_199_254_740_992.0 {
        Value::from(float as i64)
    } else {
        Number::from_f64(float).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// `parseJson`: `JSON.parse(String(value))`.
fn parse_json(row: &Row, name: &str) -> Value {
    serde_json::from_str(&js_string(row.get(name))).unwrap_or(Value::Null)
}

pub fn rows(statement: &mut Statement, params: impl rusqlite::Params) -> rusqlite::Result<Vec<Row>> {
    let names: Arc<HashMap<String, usize>> = Arc::new(
        statement.column_names().iter().enumerate().map(|(i, n)| (n.to_string(), i)).collect(),
    );
    let count = names.len();
    let mut out = Vec::new();
    let mut query = statement.query(params)?;
    while let Some(row) = query.next()? {
        let mut values = Vec::with_capacity(count);
        for i in 0..count {
            values.push(row.get::<_, Sql>(i)?);
        }
        out.push(Row { names: names.clone(), values });
    }
    Ok(out)
}

macro_rules! obj {
    ($($key:expr => $value:expr),* $(,)?) => {{
        let mut map = Map::new();
        $(map.insert($key.to_string(), $value);)*
        map
    }};
}

fn terminal(row: &Row, prefix: &str) -> Value {
    let k = |name: &str| format!("{prefix}{name}");
    Value::Object(obj! {
        "ended_at" => row.s(&k("ended_at")),
        "exit_code" => row.nn(&k("exit_code")),
        "signal" => row.ns(&k("signal")),
        "stdio_archive_ref" => row.ns(&k("stdio_archive_ref")),
        "stdio_tail" => row.s(&k("stdio_tail")),
        "terminal_cause" => row.s(&k("cause")),
        "actor" => row.s(&k("actor")),
        "generation" => row.n(&k("generation")),
        "provider_continuation_id" => row.ns(&k("provider_continuation_id")),
    })
}

fn liveness(row: &Row, prefix: &str) -> Value {
    Value::Object(obj! {
        "state" => row.s(&format!("{prefix}_state")),
        "observed_at" => row.ns(&format!("{prefix}_observed_at")),
        "detail" => row.ns(&format!("{prefix}_detail")),
    })
}

fn provider_ref(row: &Row) -> Value {
    if row.is_null("provider_execution_generation_id") {
        return Value::Null;
    }
    let kind = js_string(row.get("provider_connection_kind"));
    let mut connection = Map::new();
    let known = matches!(kind.as_str(), "codex_app_server" | "claude_cli" | "cursor_cli" | "opencode_server");
    if known {
        connection.insert("kind".into(), Value::String(kind.clone()));
        if kind == "codex_app_server" || kind == "opencode_server" {
            connection.insert("url".into(), row.s("provider_connection_url"));
        }
        connection.insert("pid".into(), row.nn("provider_connection_pid"));
        if row.b("provider_process_identity_present") {
            connection.insert("processIdentity".into(), row.ns("provider_process_identity"));
        }
        if kind == "opencode_server" {
            connection.insert("serverAuthPath".into(), row.s("provider_server_auth_path"));
        }
    }
    let mut out = obj! {
        "work_attempt_id" => row.s("provider_work_attempt_id"),
        "provider_continuation_id" => row.s("provider_continuation_id"),
        "provider_connection" => if known { Value::Object(connection) } else { Value::Null },
        "execution_generation_id" => row.s("provider_execution_generation_id"),
    };
    if !row.is_null("custodial_launch_agent_session_id") {
        out.insert("custodial_launch_agent_session_id".into(), row.s("custodial_launch_agent_session_id"));
    }
    Value::Object(out)
}

/// Prepared per-agent reads for one projection pass.
pub struct Reads<'c> {
    activity_full: Statement<'c>,
    activity_summary: Statement<'c>,
    stages: Statement<'c>,
    completed: Statement<'c>,
    exits: Statement<'c>,
    notices: Statement<'c>,
}

impl<'c> Reads<'c> {
    pub fn new(db: &'c Connection) -> rusqlite::Result<Self> {
        Ok(Self {
            activity_full: db.prepare(ACTIVITY_FULL)?,
            activity_summary: db.prepare(ACTIVITY_SUMMARY)?,
            stages: db.prepare(STAGES)?,
            completed: db.prepare(COMPLETED_ACTIONS)?,
            exits: db.prepare(EXIT_TIMESTAMPS)?,
            notices: db.prepare(NOTICES)?,
        })
    }

    /// `composeDaemonManifestEntry(projectionFromRow(row, mode))`, as JSON.
    pub fn entry(&mut self, row: &Row, mode: Activity) -> rusqlite::Result<Value> {
        let agent_id = js_string(row.get("agent_id"));

        let activity: Vec<Value> = if mode == Activity::Summary {
            let mut list = rows(&mut self.activity_summary, rusqlite::params![agent_id, SUMMARY_ACTIVITY_LIMIT])?;
            list.reverse();
            list.iter().map(activity_event).collect()
        } else {
            rows(&mut self.activity_full, [&agent_id])?.iter().map(activity_event).collect()
        };
        let stages: Vec<Value> = rows(&mut self.stages, [&agent_id])?.iter().map(|r| r.s("stage")).collect();
        let mut completed: Vec<Value> = rows(&mut self.completed, rusqlite::params![agent_id, MAX_COMPLETED_ACTION_IDS])?
            .iter().map(|r| r.s("action_id")).collect();
        completed.reverse();
        let exits: Vec<Value> = rows(&mut self.exits, [&agent_id])?.iter().map(|r| r.n("timestamp_ms")).collect();
        let notices: Vec<Value> = rows(&mut self.notices, [&agent_id])?
            .iter()
            .map(|n| {
                let mut notice = obj! { "at" => n.s("at"), "kind" => n.s("kind"), "cause" => n.s("cause") };
                if n.b("terminal_present") {
                    notice.insert("terminal".into(), terminal(n, "terminal_"));
                }
                Value::Object(notice)
            })
            .collect();

        let mut e = Map::new();
        e.insert("id".into(), Value::String(agent_id));
        e.insert("room_id".into(), row.s("room_id"));
        if row.truthy("local_room_id") {
            e.insert("local_room_id".into(), row.s("local_room_id"));
        }
        e.insert("display_name".into(), row.s("display_name"));
        if row.truthy("avatar_json") {
            if let Some(avatar) = avatar::normalize(&parse_json(row, "avatar_json")) {
                e.insert("avatar".into(), avatar);
            }
        }
        e.insert("provider".into(), row.s("provider"));
        e.insert("model".into(), row.ns("model"));
        e.insert("charter".into(), row.s("charter"));
        e.insert("desired_state".into(), row.s("desired_state"));
        e.insert("observed_state".into(), row.s("observed_state"));
        e.insert("condition".into(), row.s("condition"));
        e.insert("permission_profile_id".into(), row.ns("permission_profile_id"));
        if js_string(row.get("delivery_mode")) != "mcp_polling" {
            e.insert("delivery_mode".into(), row.s("delivery_mode"));
        }
        if !row.is_null("delivery_cutover_json") {
            e.insert("delivery_cutover".into(), parse_json(row, "delivery_cutover_json"));
        }
        e.insert("created_by".into(), row.s("created_by"));
        e.insert("created_at".into(), row.s("created_at"));
        if row.b("last_error_present") {
            e.insert("last_error".into(), row.ns("last_error"));
        }
        // A present but undefined policy is a key that JSON.stringify drops.
        if row.b("provider_launch_policy_present") && !row.b("provider_launch_policy_undefined") {
            e.insert("provider_launch_policy".into(), parse_json(row, "provider_launch_policy_json"));
        }
        if row.b("source_repo_path_present") {
            e.insert("source_repo_path".into(), row.ns("source_repo_path"));
        }
        if row.b("workspace_path_present") {
            e.insert("workspace_path".into(), row.ns("workspace_path"));
        }
        if row.b("work_attempt_id_present") {
            e.insert("work_attempt_id".into(), row.ns("work_attempt_id"));
        }
        if !row.is_null("run_id") {
            e.insert("run_id".into(), row.ns("run_id"));
            e.insert("deployment_id".into(), row.ns("deployment_id"));
        }
        if row.b("provider_ref_present") {
            e.insert("provider_ref".into(), provider_ref(row));
        }
        if row.b("workplace_liveness_present") {
            e.insert("workplace_liveness".into(), liveness(row, "workplace_liveness"));
        }
        if row.b("native_liveness_present") {
            e.insert("native_liveness".into(), liveness(row, "native_liveness"));
        }
        if row.b("ready_reached_at_present") {
            e.insert("ready_reached_at".into(), row.ns("ready_reached_at"));
        }
        if row.b("activity_present") {
            e.insert("activity".into(), Value::Array(activity));
        }
        e.insert("last_turn_control_sequence".into(), row.n("last_turn_control_sequence"));
        if row.b("turn_control_present") {
            e.insert("turn_control".into(), turn_control(row, stages));
        }
        if row.b("last_worker_binding_present") {
            let binding = if row.is_null("binding_agent_session_id") {
                Value::Null
            } else {
                Value::Object(obj! {
                    "agent_session_id" => row.s("binding_agent_session_id"),
                    "work_attempt_id" => row.s("binding_work_attempt_id"),
                    "execution_generation_id" => row.s("binding_execution_generation_id"),
                    "updated_at" => row.s("binding_updated_at"),
                })
            };
            e.insert("last_worker_binding".into(), binding);
        }
        if row.b("reconciliation_present") {
            let pending = if row.is_null("pending_action_id") {
                Value::Null
            } else {
                Value::Object(obj! {
                    "id" => row.s("pending_action_id"),
                    "sequence" => row.n("pending_action_sequence"),
                    "kind" => row.s("pending_action_kind"),
                    "recorded_at_ms" => row.n("pending_action_recorded_at_ms"),
                })
            };
            let mut reconciliation = obj! {
                "exit_timestamps_ms" => Value::Array(exits),
                "consecutive_action_failures" => row.n("consecutive_action_failures"),
                "last_observed_state" => row.s("last_observed_state"),
                "next_restart_at_ms" => row.nn("next_restart_at_ms"),
                "completed_action_ids" => Value::Array(completed),
                "last_action_sequence" => row.n("last_action_sequence"),
                "pending_action" => pending,
            };
            if row.b("last_terminal_present") {
                reconciliation.insert("last_terminal".into(), terminal(row, "terminal_"));
            }
            e.insert("reconciliation".into(), Value::Object(reconciliation));
        }
        if row.b("reconciliation_notices_present") {
            e.insert("reconciliation_notices".into(), Value::Array(notices));
        }
        Ok(Value::Object(e))
    }
}

fn activity_event(event: &Row) -> Value {
    Value::Object(obj! {
        "observed_at" => event.s("observed_at"),
        "sequence" => event.n("sequence"),
        "provider" => event.s("provider"),
        "kind" => event.s("kind"),
        "method" => event.s("method"),
        "summary" => event.s("summary"),
        "status" => event.s("status"),
        "payload" => parse_json(event, "payload_json"),
        "payload_truncated" => Value::Bool(event.b("payload_truncated")),
        "payload_redacted" => Value::Bool(event.b("payload_redacted")),
        "durable_payload_ref" => event.ns("durable_payload_ref"),
    })
}

fn turn_control(row: &Row, stages: Vec<Value>) -> Value {
    if row.is_null("action_id") {
        return Value::Null;
    }
    let mut t = obj! {
        "action_id" => row.s("action_id"),
        "action_sequence" => row.n("action_sequence"),
        "work_attempt_id" => row.s("turn_work_attempt_id"),
        "execution_generation_id" => row.s("turn_execution_generation_id"),
        "has_correction" => Value::Bool(row.b("has_correction")),
    };
    for key in [
        "target_room_id", "target_source_message_id", "target_provider_continuation_id", "inbox_item_id",
        "provider_turn_id", "correction_text", "correction_strategy", "operator_resolution",
    ] {
        if row.truthy(key) {
            t.insert(key.into(), row.s(key));
        }
    }
    let tri = |name: &str| if row.is_null(name) { Value::Null } else { Value::Bool(row.b(name)) };
    t.insert("status".into(), row.s("turn_status"));
    t.insert("capability".into(), row.s("capability"));
    t.insert("interrupted".into(), tri("interrupted"));
    t.insert("resumed".into(), tri("resumed"));
    t.insert("state".into(), if row.is_null("turn_state") { Value::Null } else { row.s("turn_state") });
    t.insert("stages".into(), Value::Array(stages));
    t.insert("error".into(), row.ns("turn_error"));
    t.insert("recorded_at".into(), row.s("recorded_at"));
    t.insert("updated_at".into(), row.s("updated_at"));
    Value::Object(t)
}

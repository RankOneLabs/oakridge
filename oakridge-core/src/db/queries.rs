// Regenerate .sqlx/ offline metadata:
//   DATABASE_URL=sqlite:/tmp/oakridge_prepare.db \
//     cargo sqlx migrate run --source src/db/migrations && \
//     cargo sqlx prepare
// Run from the oakridge-core directory.

use crate::types::{
    Artifact, ArtifactId, Project, ProjectId, RunStatus, StageInstance, StageInstanceId,
    StageStatus, WorkflowDef, WorkflowDefId, WorkflowRun, WorkflowRunId,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

// ── Row structs (SQLite-native primitives) ────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ProjectRow {
    id: String,
    name: String,
    repo_dir: String,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct WorkflowDefRow {
    id: String,
    name: String,
    version: i64,
    graph: String,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct WorkflowRunRow {
    id: String,
    workflow_def_id: String,
    project_id: Option<String>,
    status: String,
    context: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct OperatorRunSummaryRow {
    run_id: String,
    workflow_name: String,
    status: String,
    current_stage: Option<String>,
    parked_count: i64,
    is_stuck: i64,
    updated_at: String,
    archived: i64,
}

#[derive(sqlx::FromRow)]
struct StageInstanceRow {
    id: String,
    run_id: String,
    stage_key: String,
    stage_type: String,
    status: String,
    config: String,
    parked_reason: Option<String>,
    parked_meta: Option<String>,
    terminal_meta: Option<String>,
    external_ref: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(sqlx::FromRow)]
struct ArtifactRow {
    id: String,
    run_id: String,
    stage_instance_id: String,
    artifact_type: String,
    output_name: Option<String>,
    label: Option<String>,
    body: String,
    version: i64,
    parent_artifact_id: Option<String>,
    created_at: String,
}

// ── Conversion helpers ────────────────────────────────────────────────────────

fn enum_to_str<T: serde::Serialize>(v: &T) -> crate::Result<String> {
    let val = serde_json::to_value(v)?;
    val.as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| crate::Error::Validation("enum did not serialize to a string".into()))
}

fn str_to_enum<T: for<'de> serde::Deserialize<'de>>(s: String) -> crate::Result<T> {
    serde_json::from_value(Value::String(s)).map_err(crate::Error::Json)
}

fn parse_dt(s: &str) -> crate::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| crate::Error::Validation(format!("invalid timestamp '{}': {}", s, e)))
}

fn parse_uuid(s: &str) -> crate::Result<Uuid> {
    Uuid::parse_str(s).map_err(|e| crate::Error::Validation(format!("invalid uuid '{}': {}", s, e)))
}

fn opt_dt(s: Option<String>) -> crate::Result<Option<DateTime<Utc>>> {
    s.map(|s| parse_dt(&s)).transpose()
}

fn opt_json(s: Option<String>) -> crate::Result<Value> {
    match s {
        Some(s) => Ok(serde_json::from_str(&s)?),
        None => Ok(Value::Null),
    }
}

// ── Row → Domain conversions ──────────────────────────────────────────────────

fn row_to_project(r: ProjectRow) -> crate::Result<Project> {
    Ok(Project {
        id: ProjectId(parse_uuid(&r.id)?),
        name: r.name,
        repo_dir: r.repo_dir.into(),
        created_at: parse_dt(&r.created_at)?,
    })
}

fn row_to_workflow_def(r: WorkflowDefRow) -> crate::Result<WorkflowDef> {
    Ok(WorkflowDef {
        id: WorkflowDefId(parse_uuid(&r.id)?),
        name: r.name,
        version: r.version as i32,
        graph: serde_json::from_str(&r.graph)?,
        created_at: parse_dt(&r.created_at)?,
    })
}

fn row_to_workflow_run(r: WorkflowRunRow) -> crate::Result<WorkflowRun> {
    Ok(WorkflowRun {
        id: WorkflowRunId(parse_uuid(&r.id)?),
        workflow_def_id: WorkflowDefId(parse_uuid(&r.workflow_def_id)?),
        project_id: r
            .project_id
            .as_deref()
            .map(parse_uuid)
            .transpose()?
            .map(ProjectId),
        status: str_to_enum(r.status)?,
        context: opt_json(r.context)?,
        version: r.version as i32,
        created_at: parse_dt(&r.created_at)?,
        updated_at: parse_dt(&r.updated_at)?,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct OperatorRunSummary {
    pub run_id: WorkflowRunId,
    pub workflow_name: String,
    pub status: RunStatus,
    pub current_stage: Option<String>,
    pub parked_count: usize,
    /// True when any stage in this run is parked with parked_reason = 'stuck_timeout'.
    pub is_stuck: bool,
    pub updated_at: DateTime<Utc>,
    pub archived: bool,
}

fn row_to_operator_run_summary(r: OperatorRunSummaryRow) -> crate::Result<OperatorRunSummary> {
    Ok(OperatorRunSummary {
        run_id: WorkflowRunId(parse_uuid(&r.run_id)?),
        workflow_name: r.workflow_name,
        status: str_to_enum(r.status)?,
        current_stage: r.current_stage,
        parked_count: r.parked_count as usize,
        is_stuck: r.is_stuck != 0,
        updated_at: parse_dt(&r.updated_at)?,
        archived: r.archived != 0,
    })
}

fn row_to_stage_instance(r: StageInstanceRow) -> crate::Result<StageInstance> {
    Ok(StageInstance {
        id: StageInstanceId(parse_uuid(&r.id)?),
        run_id: WorkflowRunId(parse_uuid(&r.run_id)?),
        stage_key: r.stage_key,
        stage_type: r.stage_type,
        status: str_to_enum(r.status)?,
        config: serde_json::from_str(&r.config)?,
        parked_reason: r.parked_reason,
        parked_meta: r
            .parked_meta
            .map(|s| serde_json::from_str(&s))
            .transpose()?,
        terminal_meta: r
            .terminal_meta
            .map(|s| serde_json::from_str(&s))
            .transpose()?,
        external_ref: r.external_ref,
        started_at: opt_dt(r.started_at)?,
        ended_at: opt_dt(r.ended_at)?,
        created_at: parse_dt(&r.created_at)?,
        updated_at: parse_dt(&r.updated_at)?,
    })
}

fn row_to_artifact(r: ArtifactRow) -> crate::Result<Artifact> {
    Ok(Artifact {
        id: ArtifactId(parse_uuid(&r.id)?),
        run_id: WorkflowRunId(parse_uuid(&r.run_id)?),
        stage_instance_id: StageInstanceId(parse_uuid(&r.stage_instance_id)?),
        artifact_type: r.artifact_type,
        output_name: r.output_name,
        label: r.label,
        body: serde_json::from_str(&r.body)?,
        version: r.version as i32,
        parent_artifact_id: r
            .parent_artifact_id
            .as_deref()
            .map(parse_uuid)
            .transpose()?
            .map(ArtifactId),
        created_at: parse_dt(&r.created_at)?,
    })
}

// ── Project ───────────────────────────────────────────────────────────────────

pub async fn insert_project(pool: &SqlitePool, p: &Project) -> crate::Result<()> {
    let id = p.id.0.to_string();
    let repo_dir = p
        .repo_dir
        .to_str()
        .ok_or_else(|| {
            crate::Error::Validation(format!("repo_dir is not valid UTF-8: {:?}", p.repo_dir))
        })?
        .to_string();
    let created_at = p.created_at.to_rfc3339();
    sqlx::query!(
        "INSERT INTO project (id, name, repo_dir, created_at) VALUES (?, ?, ?, ?)",
        id,
        p.name,
        repo_dir,
        created_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_projects(pool: &SqlitePool) -> crate::Result<Vec<Project>> {
    let rows = sqlx::query_as::<_, ProjectRow>(
        "SELECT id, name, repo_dir, created_at FROM project ORDER BY created_at, id",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_project).collect()
}

pub async fn get_project_by_id(pool: &SqlitePool, id: &ProjectId) -> crate::Result<Project> {
    let id_str = id.0.to_string();
    let row = sqlx::query_as!(
        ProjectRow,
        "SELECT id, name, repo_dir, created_at FROM project WHERE id = ?",
        id_str,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::Error::NotFound {
        entity: "project".into(),
        id: id_str,
    })?;
    row_to_project(row)
}

// ── WorkflowDef ───────────────────────────────────────────────────────────────

pub async fn insert_workflow_def(pool: &SqlitePool, d: &WorkflowDef) -> crate::Result<()> {
    let id = d.id.0.to_string();
    let version = d.version as i64;
    let graph = serde_json::to_string(&d.graph)?;
    let created_at = d.created_at.to_rfc3339();
    sqlx::query!(
        "INSERT INTO workflow_def (id, name, version, graph, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        d.name,
        version,
        graph,
        created_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_workflow_defs(pool: &SqlitePool) -> crate::Result<Vec<WorkflowDef>> {
    let rows = sqlx::query_as::<_, WorkflowDefRow>(
        "SELECT id, name, version, graph, created_at FROM workflow_def ORDER BY created_at, id",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_workflow_def).collect()
}

pub async fn get_workflow_def_by_id(
    pool: &SqlitePool,
    id: &WorkflowDefId,
) -> crate::Result<WorkflowDef> {
    let id_str = id.0.to_string();
    let row = sqlx::query_as!(
        WorkflowDefRow,
        "SELECT id, name, version, graph, created_at FROM workflow_def WHERE id = ?",
        id_str,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::Error::NotFound {
        entity: "workflow_def".into(),
        id: id_str,
    })?;
    row_to_workflow_def(row)
}

pub async fn get_workflow_def_by_name_version(
    pool: &SqlitePool,
    name: &str,
    version: i32,
) -> crate::Result<Option<WorkflowDef>> {
    let version_i64 = version as i64;
    let row = sqlx::query_as::<_, WorkflowDefRow>(
        "SELECT id, name, version, graph, created_at FROM workflow_def WHERE name = ? AND version = ?",
    )
    .bind(name)
    .bind(version_i64)
    .fetch_optional(pool)
    .await?;
    row.map(row_to_workflow_def).transpose()
}

// ── WorkflowRun ───────────────────────────────────────────────────────────────

pub async fn insert_workflow_run(pool: &SqlitePool, r: &WorkflowRun) -> crate::Result<()> {
    let id = r.id.0.to_string();
    let workflow_def_id = r.workflow_def_id.0.to_string();
    let project_id = r.project_id.map(|p| p.0.to_string());
    let status = enum_to_str(&r.status)?;
    let context = serde_json::to_string(&r.context)?;
    let version = r.version as i64;
    let created_at = r.created_at.to_rfc3339();
    let updated_at = r.updated_at.to_rfc3339();
    sqlx::query!(
        "INSERT INTO workflow_run \
         (id, workflow_def_id, project_id, status, context, version, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        workflow_def_id,
        project_id,
        status,
        context,
        version,
        created_at,
        updated_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_workflow_run_by_id(
    pool: &SqlitePool,
    id: &WorkflowRunId,
) -> crate::Result<WorkflowRun> {
    let id_str = id.0.to_string();
    let row = sqlx::query_as!(
        WorkflowRunRow,
        "SELECT id, workflow_def_id, project_id, status, context, version, created_at, updated_at \
         FROM workflow_run WHERE id = ?",
        id_str,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::Error::NotFound {
        entity: "workflow_run".into(),
        id: id_str,
    })?;
    row_to_workflow_run(row)
}

pub async fn update_workflow_run_status(
    pool: &SqlitePool,
    id: &WorkflowRunId,
    status: RunStatus,
) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let status_str = enum_to_str(&status)?;
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query!(
        "UPDATE workflow_run SET status = ?, updated_at = ? WHERE id = ?",
        status_str,
        updated_at,
        id_str,
    )
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "workflow_run".into(),
            id: id_str,
        });
    }
    Ok(())
}

pub async fn update_workflow_run_status_if_non_terminal(
    pool: &SqlitePool,
    id: &WorkflowRunId,
    status: RunStatus,
) -> crate::Result<bool> {
    let id_str = id.0.to_string();
    let status_str = enum_to_str(&status)?;
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE workflow_run SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done', 'failed')",
    )
    .bind(status_str)
    .bind(updated_at)
    .bind(id_str)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn mark_workflow_run_failed_if_pending(
    pool: &SqlitePool,
    id: &WorkflowRunId,
) -> crate::Result<bool> {
    let id_str = id.0.to_string();
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE workflow_run SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(updated_at)
    .bind(id_str)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn list_workflow_runs(
    pool: &SqlitePool,
    status: Option<RunStatus>,
    def_id: Option<&WorkflowDefId>,
    project_id: Option<&ProjectId>,
) -> crate::Result<Vec<WorkflowRun>> {
    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT id, workflow_def_id, project_id, status, context, version, created_at, updated_at \
         FROM workflow_run WHERE 1=1",
    );
    if let Some(s) = status {
        let s_str = enum_to_str(&s)?;
        qb.push(" AND status = ").push_bind(s_str);
    }
    if let Some(d) = def_id {
        qb.push(" AND workflow_def_id = ")
            .push_bind(d.0.to_string());
    }
    if let Some(p) = project_id {
        qb.push(" AND project_id = ").push_bind(p.0.to_string());
    }
    qb.push(" ORDER BY created_at, id");
    let rows = qb
        .build_query_as::<WorkflowRunRow>()
        .fetch_all(pool)
        .await?;
    rows.into_iter().map(row_to_workflow_run).collect()
}

/// List operator run summaries with an optional archived filter.
/// `archived = Some(true)` → archived only; `Some(false)` → active only (default);
/// `None` → all runs regardless of archived flag.
pub async fn list_operator_run_summaries(
    pool: &SqlitePool,
    archived: Option<bool>,
) -> crate::Result<Vec<OperatorRunSummary>> {
    let where_clause = match archived {
        Some(true) => " WHERE wr.archived = 1",
        Some(false) => " WHERE wr.archived = 0",
        None => "",
    };
    let sql = format!(
        "SELECT \
             wr.id AS run_id, \
             wd.name AS workflow_name, \
             wr.status AS status, \
             COALESCE( \
                 MIN(CASE WHEN si.status = 'parked' THEN si.stage_key END), \
                 MIN(CASE WHEN si.status = 'running' THEN si.stage_key END), \
                 MIN(CASE WHEN si.status = 'pending' THEN si.stage_key END) \
             ) AS current_stage, \
             COALESCE(SUM(CASE WHEN si.status = 'parked' THEN 1 ELSE 0 END), 0) AS parked_count, \
             COALESCE(MAX(CASE WHEN si.status = 'parked' AND si.parked_reason = 'stuck_timeout' THEN 1 ELSE 0 END), 0) AS is_stuck, \
             wr.updated_at AS updated_at, \
             wr.archived AS archived \
         FROM workflow_run wr \
         INNER JOIN workflow_def wd ON wd.id = wr.workflow_def_id \
         LEFT JOIN stage_instance si ON si.run_id = wr.id\
         {where_clause} \
         GROUP BY wr.id, wd.name, wr.status, wr.updated_at, wr.created_at, wr.archived \
         ORDER BY wr.created_at, wr.id"
    );
    let rows = sqlx::query_as::<_, OperatorRunSummaryRow>(&sql)
        .fetch_all(pool)
        .await?;
    rows.into_iter().map(row_to_operator_run_summary).collect()
}

pub async fn archive_run(pool: &SqlitePool, id: &WorkflowRunId) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let result = sqlx::query("UPDATE workflow_run SET archived = 1 WHERE id = ?")
        .bind(&id_str)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "workflow_run".into(),
            id: id_str,
        });
    }
    Ok(())
}

pub async fn unarchive_run(pool: &SqlitePool, id: &WorkflowRunId) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let result = sqlx::query("UPDATE workflow_run SET archived = 0 WHERE id = ?")
        .bind(&id_str)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "workflow_run".into(),
            id: id_str,
        });
    }
    Ok(())
}

pub async fn delete_run(pool: &SqlitePool, id: &WorkflowRunId) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let mut txn = pool.begin().await?;
    let result = sqlx::query("DELETE FROM workflow_run WHERE id = ?")
        .bind(&id_str)
        .execute(&mut *txn)
        .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "workflow_run".into(),
            id: id_str,
        });
    }
    txn.commit().await?;
    Ok(())
}

pub async fn list_active_runs(pool: &SqlitePool) -> crate::Result<Vec<WorkflowRun>> {
    let rows = sqlx::query_as!(
        WorkflowRunRow,
        "SELECT id, workflow_def_id, project_id, status, context, version, created_at, updated_at \
         FROM workflow_run WHERE status IN ('pending', 'running') ORDER BY created_at, id",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_workflow_run).collect()
}

// ── StageInstance ─────────────────────────────────────────────────────────────

pub async fn insert_stage_instance(pool: &SqlitePool, s: &StageInstance) -> crate::Result<()> {
    let id = s.id.0.to_string();
    let run_id = s.run_id.0.to_string();
    let status = enum_to_str(&s.status)?;
    let config = serde_json::to_string(&s.config)?;
    let parked_meta = s
        .parked_meta
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let terminal_meta = s
        .terminal_meta
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let started_at = s.started_at.map(|t| t.to_rfc3339());
    let ended_at = s.ended_at.map(|t| t.to_rfc3339());
    let created_at = s.created_at.to_rfc3339();
    let updated_at = s.updated_at.to_rfc3339();
    sqlx::query(
        "INSERT INTO stage_instance \
         (id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, terminal_meta, external_ref, \
          started_at, ended_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(run_id)
    .bind(s.stage_key.clone())
    .bind(s.stage_type.clone())
    .bind(status)
    .bind(config)
    .bind(s.parked_reason.clone())
    .bind(parked_meta)
    .bind(terminal_meta)
    .bind(s.external_ref.clone())
    .bind(started_at)
    .bind(ended_at)
    .bind(created_at)
    .bind(updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_stage_instance_by_id(
    pool: &SqlitePool,
    id: &StageInstanceId,
) -> crate::Result<StageInstance> {
    let id_str = id.0.to_string();
    let row = sqlx::query_as::<_, StageInstanceRow>(
        "SELECT id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, terminal_meta, external_ref, \
         started_at, ended_at, created_at, updated_at \
         FROM stage_instance WHERE id = ?",
    )
    .bind(&id_str)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::Error::NotFound {
        entity: "stage_instance".into(),
        id: id_str,
    })?;
    row_to_stage_instance(row)
}

pub async fn update_stage_instance_status(
    pool: &SqlitePool,
    id: &StageInstanceId,
    status: StageStatus,
    parked_reason: Option<String>,
    terminal_meta: Option<Value>,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
) -> crate::Result<()> {
    update_stage_instance_status_with_terminal_meta(
        pool,
        id,
        status,
        parked_reason,
        terminal_meta,
        started_at,
        ended_at,
    )
    .await
}

pub async fn update_stage_instance_status_with_terminal_meta(
    pool: &SqlitePool,
    id: &StageInstanceId,
    status: StageStatus,
    parked_reason: Option<String>,
    terminal_meta: Option<Value>,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let status_str = enum_to_str(&status)?;
    let updated_at = Utc::now().to_rfc3339();
    let started_at_str = started_at.map(|t| t.to_rfc3339());
    let ended_at_str = ended_at.map(|t| t.to_rfc3339());
    let terminal_meta = terminal_meta
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let result = sqlx::query(
        "UPDATE stage_instance \
         SET status = ?, parked_reason = ?, terminal_meta = ?, started_at = ?, ended_at = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(status_str)
    .bind(parked_reason)
    .bind(terminal_meta)
    .bind(started_at_str)
    .bind(ended_at_str)
    .bind(updated_at)
    .bind(&id_str)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "stage_instance".into(),
            id: id_str,
        });
    }
    Ok(())
}

/// Set (or clear, with `None`) the structured park metadata an executor attaches
/// while a stage is parked. Kept independent of `update_stage_instance_status` so
/// it does not disturb that function's many call sites.
pub async fn set_stage_instance_parked_meta(
    pool: &SqlitePool,
    id: &StageInstanceId,
    parked_meta: Option<Value>,
) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let parked_meta = parked_meta
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query!(
        "UPDATE stage_instance SET parked_meta = ?, updated_at = ? WHERE id = ?",
        parked_meta,
        updated_at,
        id_str,
    )
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "stage_instance".into(),
            id: id_str,
        });
    }
    Ok(())
}

/// Set (or clear, with `None`) the durable external substrate reference attached
/// to a stage instance. Kept narrow so executors can persist their handoff handle
/// without touching status or park metadata.
pub async fn set_stage_instance_external_ref(
    pool: &SqlitePool,
    id: &StageInstanceId,
    external_ref: Option<String>,
) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let updated_at = Utc::now().to_rfc3339();
    let result =
        sqlx::query("UPDATE stage_instance SET external_ref = ?, updated_at = ? WHERE id = ?")
            .bind(external_ref)
            .bind(updated_at)
            .bind(&id_str)
            .execute(pool)
            .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "stage_instance".into(),
            id: id_str,
        });
    }
    Ok(())
}

pub async fn update_stage_instance_status_if_current_status(
    pool: &SqlitePool,
    id: &StageInstanceId,
    expected_status: StageStatus,
    status: StageStatus,
    parked_reason: Option<String>,
    terminal_meta: Option<Value>,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
) -> crate::Result<bool> {
    update_stage_instance_status_if_current_status_with_terminal_meta(
        pool,
        id,
        expected_status,
        status,
        parked_reason,
        terminal_meta,
        started_at,
        ended_at,
    )
    .await
}

pub async fn update_stage_instance_status_if_current_status_with_terminal_meta(
    pool: &SqlitePool,
    id: &StageInstanceId,
    expected_status: StageStatus,
    status: StageStatus,
    parked_reason: Option<String>,
    terminal_meta: Option<Value>,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
) -> crate::Result<bool> {
    let id_str = id.0.to_string();
    let expected_status_str = enum_to_str(&expected_status)?;
    let status_str = enum_to_str(&status)?;
    let updated_at = Utc::now().to_rfc3339();
    let started_at_str = started_at.map(|t| t.to_rfc3339());
    let ended_at_str = ended_at.map(|t| t.to_rfc3339());
    let terminal_meta = terminal_meta
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let result = sqlx::query(
        "UPDATE stage_instance \
         SET status = ?, parked_reason = ?, terminal_meta = ?, started_at = ?, ended_at = ?, updated_at = ? \
         WHERE id = ? AND status = ?",
    )
    .bind(status_str)
    .bind(parked_reason)
    .bind(terminal_meta)
    .bind(started_at_str)
    .bind(ended_at_str)
    .bind(updated_at)
    .bind(id_str)
    .bind(expected_status_str)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn list_stage_instances_for_run(
    pool: &SqlitePool,
    run_id: &WorkflowRunId,
) -> crate::Result<Vec<StageInstance>> {
    let run_id_str = run_id.0.to_string();
    let rows = sqlx::query_as::<_, StageInstanceRow>(
        "SELECT id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, terminal_meta, external_ref, \
         started_at, ended_at, created_at, updated_at \
         FROM stage_instance WHERE run_id = ?",
    )
    .bind(run_id_str)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_stage_instance).collect()
}

/// Bulk-transition all Pending, Running, and Parked stage instances for a run to
/// Failed with the given terminal_meta. Returns the number of rows updated.
pub async fn cancel_non_terminal_stage_instances_for_run(
    pool: &SqlitePool,
    run_id: &WorkflowRunId,
    terminal_meta: &serde_json::Value,
) -> crate::Result<u64> {
    let run_id_str = run_id.0.to_string();
    let terminal_meta_str = serde_json::to_string(terminal_meta)?;
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE stage_instance \
         SET status = 'failed', terminal_meta = ?, ended_at = ?, updated_at = ?, parked_reason = NULL, parked_meta = NULL \
         WHERE run_id = ? AND status IN ('pending', 'running', 'parked')",
    )
    .bind(&terminal_meta_str)
    .bind(&now)
    .bind(&now)
    .bind(&run_id_str)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn list_parked_stage_instances(pool: &SqlitePool) -> crate::Result<Vec<StageInstance>> {
    let rows = sqlx::query_as::<_, StageInstanceRow>(
        "SELECT id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, terminal_meta, external_ref, \
         started_at, ended_at, created_at, updated_at \
         FROM stage_instance WHERE status = 'parked'",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_stage_instance).collect()
}

/// Bump updated_at on a stage instance without changing its status.
/// Used by StageContext::heartbeat and after successful artifact emits to
/// signal liveness to the stuck-stage sweeper.
pub async fn touch_stage_instance(pool: &SqlitePool, id: &StageInstanceId) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query("UPDATE stage_instance SET updated_at = ? WHERE id = ?")
        .bind(updated_at)
        .bind(&id_str)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "stage_instance".into(),
            id: id_str,
        });
    }
    Ok(())
}

/// List Running stage instances whose updated_at is strictly older than cutoff.
/// Used by the stuck-stage sweeper to find candidates for parking.
pub async fn list_running_stage_instances_older_than(
    pool: &SqlitePool,
    cutoff: DateTime<Utc>,
) -> crate::Result<Vec<StageInstance>> {
    let cutoff_str = cutoff.to_rfc3339();
    let rows = sqlx::query_as::<_, StageInstanceRow>(
        "SELECT id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, \
         terminal_meta, external_ref, started_at, ended_at, created_at, updated_at \
         FROM stage_instance WHERE status = 'running' AND updated_at < ?",
    )
    .bind(cutoff_str)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_stage_instance).collect()
}

/// Conditionally transition a Running stage instance to Parked with
/// parked_reason = 'stuck_timeout'. Returns true when the CAS update succeeded
/// (stage was still Running), false when it had already moved on.
pub async fn park_stage_instance_as_stuck(
    pool: &SqlitePool,
    id: &StageInstanceId,
    parked_meta: &serde_json::Value,
) -> crate::Result<bool> {
    let id_str = id.0.to_string();
    let parked_meta_str = serde_json::to_string(parked_meta)?;
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE stage_instance \
         SET status = 'parked', parked_reason = 'stuck_timeout', parked_meta = ?, \
             updated_at = ? \
         WHERE id = ? AND status = 'running'",
    )
    .bind(parked_meta_str)
    .bind(updated_at)
    .bind(id_str)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Atomically transition a stuck-parked stage instance back to Running and
/// clear parked metadata. Returns false if the row is no longer parked as
/// stuck_timeout.
pub async fn retry_stuck_stage_instance(
    pool: &SqlitePool,
    id: &StageInstanceId,
    started_at: Option<DateTime<Utc>>,
) -> crate::Result<bool> {
    let id_str = id.0.to_string();
    let updated_at = Utc::now().to_rfc3339();
    let started_at_str = started_at.map(|t| t.to_rfc3339());
    let result = sqlx::query(
        "UPDATE stage_instance \
         SET status = 'running', parked_reason = NULL, parked_meta = NULL, \
             terminal_meta = NULL, external_ref = NULL, started_at = ?, \
             ended_at = NULL, updated_at = ? \
         WHERE id = ? AND status = 'parked' AND parked_reason = 'stuck_timeout'",
    )
    .bind(started_at_str)
    .bind(updated_at)
    .bind(id_str)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

// ── Artifact ──────────────────────────────────────────────────────────────────

pub async fn insert_artifact(pool: &SqlitePool, a: &Artifact) -> crate::Result<()> {
    let id = a.id.0.to_string();
    let run_id = a.run_id.0.to_string();
    let stage_instance_id = a.stage_instance_id.0.to_string();
    let body = serde_json::to_string(&a.body)?;
    let version = a.version as i64;
    let parent_artifact_id = a.parent_artifact_id.map(|p| p.0.to_string());
    let created_at = a.created_at.to_rfc3339();
    sqlx::query!(
        "INSERT INTO artifact \
         (id, run_id, stage_instance_id, artifact_type, output_name, label, body, version, parent_artifact_id, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        run_id,
        stage_instance_id,
        a.artifact_type,
        a.output_name,
        a.label,
        body,
        version,
        parent_artifact_id,
        created_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_artifact_by_id(pool: &SqlitePool, id: &ArtifactId) -> crate::Result<Artifact> {
    let id_str = id.0.to_string();
    let row = sqlx::query_as!(
        ArtifactRow,
        "SELECT id, run_id, stage_instance_id, artifact_type, output_name, label, body, version, \
         parent_artifact_id, created_at \
         FROM artifact WHERE id = ?",
        id_str,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::Error::NotFound {
        entity: "artifact".into(),
        id: id_str,
    })?;
    row_to_artifact(row)
}

pub async fn get_artifact_chain(
    pool: &SqlitePool,
    id: &ArtifactId,
) -> crate::Result<Vec<Artifact>> {
    let mut chain = vec![];
    let mut seen = std::collections::HashSet::new();
    let mut current_id = Some(*id);
    while let Some(aid) = current_id {
        if !seen.insert(aid) {
            return Err(crate::Error::Validation(format!(
                "artifact chain contains a cycle at {}",
                aid.0
            )));
        }
        let artifact = get_artifact_by_id(pool, &aid).await?;
        current_id = artifact.parent_artifact_id;
        chain.push(artifact);
    }
    Ok(chain)
}

/// Walk `parent_artifact_id` to the chain root, reading only `id`/`parent_artifact_id`
/// (never the body) — the lightweight form of [`get_artifact_chain`] for callers that
/// only need the root id (thread / atom-edit / review-item anchoring). Detects cycles.
pub async fn get_artifact_chain_root_id(pool: &SqlitePool, id: &ArtifactId) -> crate::Result<String> {
    let mut seen = std::collections::HashSet::new();
    let mut current = id.0.to_string();
    loop {
        if !seen.insert(current.clone()) {
            return Err(crate::Error::Validation(format!(
                "artifact chain contains a cycle at {current}"
            )));
        }
        // `Option<Option<String>>`: outer None = no such artifact row; inner None =
        // NULL parent (the root); inner Some = the parent id to walk to next.
        let parent: Option<Option<String>> =
            sqlx::query_scalar("SELECT parent_artifact_id FROM artifact WHERE id = ?")
                .bind(&current)
                .fetch_optional(pool)
                .await?;
        match parent {
            None => {
                return Err(crate::Error::NotFound {
                    entity: "artifact".into(),
                    id: current,
                })
            }
            Some(None) => return Ok(current),
            Some(Some(parent_id)) => current = parent_id,
        }
    }
}

pub async fn list_artifacts_for_run(
    pool: &SqlitePool,
    run_id: &WorkflowRunId,
    artifact_type: Option<&str>,
) -> crate::Result<Vec<Artifact>> {
    let run_id_str = run_id.0.to_string();
    let rows: Vec<ArtifactRow> = if let Some(at) = artifact_type {
        sqlx::query_as!(
            ArtifactRow,
            "SELECT id, run_id, stage_instance_id, artifact_type, output_name, label, body, version, \
             parent_artifact_id, created_at \
             FROM artifact WHERE run_id = ? AND artifact_type = ? ORDER BY created_at, id",
            run_id_str,
            at,
        )
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as!(
            ArtifactRow,
            "SELECT id, run_id, stage_instance_id, artifact_type, output_name, label, body, version, \
             parent_artifact_id, created_at \
             FROM artifact WHERE run_id = ? ORDER BY created_at, id",
            run_id_str,
        )
        .fetch_all(pool)
        .await?
    };
    rows.into_iter().map(row_to_artifact).collect()
}

/// Return the most recently created artifact for the given stage instance and output
/// slot name, or None if no such artifact exists yet.
pub async fn get_latest_artifact_by_stage_and_output(
    pool: &SqlitePool,
    stage_instance_id: &StageInstanceId,
    output_name: &str,
) -> crate::Result<Option<Artifact>> {
    let id_str = stage_instance_id.0.to_string();
    let row = sqlx::query_as::<_, ArtifactRow>(
        "SELECT id, run_id, stage_instance_id, artifact_type, output_name, label, body, version, \
         parent_artifact_id, created_at \
         FROM artifact \
         WHERE stage_instance_id = ? AND output_name = ? \
         ORDER BY created_at DESC, id DESC \
         LIMIT 1",
    )
    .bind(&id_str)
    .bind(output_name)
    .fetch_optional(pool)
    .await?;
    row.map(row_to_artifact).transpose()
}

/// Return the latest artifact for one output and unit label.  Fan-out stages
/// share a stage instance, so merge-gate PR discovery must not cross units.
pub async fn get_latest_artifact_by_stage_output_and_label(
    pool: &SqlitePool,
    stage_instance_id: &StageInstanceId,
    output_name: &str,
    label: &str,
) -> crate::Result<Option<Artifact>> {
    let row = sqlx::query_as::<_, ArtifactRow>(
        "SELECT id, run_id, stage_instance_id, artifact_type, output_name, label, body, version, \
         parent_artifact_id, created_at FROM artifact \
         WHERE stage_instance_id = ? AND output_name = ? AND label = ? \
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(stage_instance_id.0.to_string())
    .bind(output_name)
    .bind(label)
    .fetch_optional(pool)
    .await?;
    row.map(row_to_artifact).transpose()
}

// ── SessionUnit ───────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct SessionUnitRow {
    stage_instance_id: String,
    unit_id: String,
    params: Option<String>,
    depends_on: String,
    external_ref: Option<String>,
    worktree_branch: Option<String>,
    worktree_path: Option<String>,
    worktree_base_ref: Option<String>,
    status: String,
    gate_state: Option<String>,
    artifact_id: Option<String>,
    terminal_meta: Option<String>,
    created_at: String,
    updated_at: String,
}

fn row_to_session_unit(r: SessionUnitRow) -> crate::Result<crate::types::SessionUnit> {
    use crate::types::{ArtifactId, SessionUnit};
    Ok(SessionUnit {
        stage_instance_id: StageInstanceId(parse_uuid(&r.stage_instance_id)?),
        unit_id: r.unit_id,
        params: r.params.map(|s| serde_json::from_str(&s)).transpose()?,
        depends_on: serde_json::from_str(&r.depends_on)?,
        external_ref: r.external_ref,
        worktree_branch: r.worktree_branch,
        worktree_path: r.worktree_path,
        worktree_base_ref: r.worktree_base_ref,
        status: str_to_enum(r.status)?,
        gate_state: r.gate_state.map(|s| serde_json::from_str(&s)).transpose()?,
        artifact_id: r.artifact_id.as_deref().map(parse_uuid).transpose()?.map(ArtifactId),
        terminal_meta: r.terminal_meta.map(|s| serde_json::from_str(&s)).transpose()?,
        created_at: parse_dt(&r.created_at)?,
        updated_at: parse_dt(&r.updated_at)?,
    })
}

/// Insert or replace a session unit (upsert). Uses INSERT OR REPLACE so callers
/// can call this to both create and overwrite (e.g. on retry).
pub async fn upsert_session_unit(
    pool: &SqlitePool,
    unit: &crate::types::SessionUnit,
) -> crate::Result<()> {
    let stage_instance_id = unit.stage_instance_id.0.to_string();
    let params = unit.params.as_ref().map(serde_json::to_string).transpose()?;
    let depends_on = serde_json::to_string(&unit.depends_on)?;
    let status = enum_to_str(&unit.status)?;
    let gate_state = unit.gate_state.as_ref().map(serde_json::to_string).transpose()?;
    let artifact_id = unit.artifact_id.map(|id| id.0.to_string());
    let terminal_meta = unit.terminal_meta.as_ref().map(serde_json::to_string).transpose()?;
    let created_at = unit.created_at.to_rfc3339();
    let updated_at = unit.updated_at.to_rfc3339();
    sqlx::query(
        "INSERT OR REPLACE INTO stage_session_units \
         (stage_instance_id, unit_id, params, depends_on, external_ref, \
          worktree_branch, worktree_path, worktree_base_ref, \
          status, gate_state, artifact_id, terminal_meta, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&stage_instance_id)
    .bind(&unit.unit_id)
    .bind(params)
    .bind(depends_on)
    .bind(&unit.external_ref)
    .bind(&unit.worktree_branch)
    .bind(&unit.worktree_path)
    .bind(&unit.worktree_base_ref)
    .bind(status)
    .bind(gate_state)
    .bind(artifact_id)
    .bind(terminal_meta)
    .bind(created_at)
    .bind(updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_session_units_for_stage(
    pool: &SqlitePool,
    stage_instance_id: &StageInstanceId,
) -> crate::Result<Vec<crate::types::SessionUnit>> {
    let id_str = stage_instance_id.0.to_string();
    let rows = sqlx::query_as::<_, SessionUnitRow>(
        "SELECT stage_instance_id, unit_id, params, depends_on, external_ref, \
         worktree_branch, worktree_path, worktree_base_ref, \
         status, gate_state, artifact_id, terminal_meta, created_at, updated_at \
         FROM stage_session_units WHERE stage_instance_id = ? ORDER BY unit_id",
    )
    .bind(id_str)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_session_unit).collect()
}

pub async fn list_session_units_for_run(
    pool: &SqlitePool,
    run_id: &WorkflowRunId,
) -> crate::Result<Vec<crate::types::SessionUnit>> {
    let id_str = run_id.0.to_string();
    let rows = sqlx::query_as::<_, SessionUnitRow>(
        "SELECT ssu.stage_instance_id, ssu.unit_id, ssu.params, ssu.depends_on, ssu.external_ref, \
         ssu.worktree_branch, ssu.worktree_path, ssu.worktree_base_ref, \
         ssu.status, ssu.gate_state, ssu.artifact_id, ssu.terminal_meta, ssu.created_at, ssu.updated_at \
         FROM stage_session_units ssu \
         JOIN stage_instance si ON si.id = ssu.stage_instance_id \
         WHERE si.run_id = ? ORDER BY ssu.stage_instance_id, ssu.unit_id",
    )
    .bind(id_str)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_session_unit).collect()
}

pub async fn get_session_unit(
    pool: &SqlitePool,
    stage_instance_id: &StageInstanceId,
    unit_id: &str,
) -> crate::Result<crate::types::SessionUnit> {
    let id_str = stage_instance_id.0.to_string();
    let row = sqlx::query_as::<_, SessionUnitRow>(
        "SELECT stage_instance_id, unit_id, params, depends_on, external_ref, \
         worktree_branch, worktree_path, worktree_base_ref, \
         status, gate_state, artifact_id, terminal_meta, created_at, updated_at \
         FROM stage_session_units WHERE stage_instance_id = ? AND unit_id = ?",
    )
    .bind(&id_str)
    .bind(unit_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::Error::NotFound {
        entity: "session_unit".into(),
        id: format!("{}:{}", id_str, unit_id),
    })?;
    row_to_session_unit(row)
}

pub async fn set_session_unit_status(
    pool: &SqlitePool,
    stage_instance_id: &StageInstanceId,
    unit_id: &str,
    status: crate::types::UnitStatus,
    terminal_meta: Option<serde_json::Value>,
) -> crate::Result<()> {
    let id_str = stage_instance_id.0.to_string();
    let status_str = enum_to_str(&status)?;
    let terminal_meta_str = terminal_meta.as_ref().map(serde_json::to_string).transpose()?;
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE stage_session_units SET status = ?, terminal_meta = ?, updated_at = ? \
         WHERE stage_instance_id = ? AND unit_id = ?",
    )
    .bind(status_str)
    .bind(terminal_meta_str)
    .bind(updated_at)
    .bind(&id_str)
    .bind(unit_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "session_unit".into(),
            id: format!("{}:{}", id_str, unit_id),
        });
    }
    Ok(())
}

pub async fn set_session_unit_external_ref(
    pool: &SqlitePool,
    stage_instance_id: &StageInstanceId,
    unit_id: &str,
    external_ref: Option<String>,
    worktree_branch: Option<String>,
    worktree_path: Option<String>,
    worktree_base_ref: Option<String>,
) -> crate::Result<()> {
    let id_str = stage_instance_id.0.to_string();
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE stage_session_units \
         SET external_ref = ?, worktree_branch = ?, worktree_path = ?, worktree_base_ref = ?, \
             updated_at = ? \
         WHERE stage_instance_id = ? AND unit_id = ?",
    )
    .bind(&external_ref)
    .bind(&worktree_branch)
    .bind(&worktree_path)
    .bind(&worktree_base_ref)
    .bind(updated_at)
    .bind(&id_str)
    .bind(unit_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "session_unit".into(),
            id: format!("{}:{}", id_str, unit_id),
        });
    }
    Ok(())
}

pub async fn set_session_unit_gate_state(
    pool: &SqlitePool,
    stage_instance_id: &StageInstanceId,
    unit_id: &str,
    gate_state: Option<serde_json::Value>,
) -> crate::Result<()> {
    let id_str = stage_instance_id.0.to_string();
    let gate_state_str = gate_state.as_ref().map(serde_json::to_string).transpose()?;
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE stage_session_units SET gate_state = ?, updated_at = ? \
         WHERE stage_instance_id = ? AND unit_id = ?",
    )
    .bind(gate_state_str)
    .bind(updated_at)
    .bind(&id_str)
    .bind(unit_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "session_unit".into(),
            id: format!("{}:{}", id_str, unit_id),
        });
    }
    Ok(())
}

pub async fn set_session_unit_artifact_id(
    pool: &SqlitePool,
    stage_instance_id: &StageInstanceId,
    unit_id: &str,
    artifact_id: crate::types::ArtifactId,
) -> crate::Result<()> {
    let id_str = stage_instance_id.0.to_string();
    let artifact_id_str = artifact_id.0.to_string();
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE stage_session_units SET artifact_id = ?, updated_at = ? \
         WHERE stage_instance_id = ? AND unit_id = ?",
    )
    .bind(artifact_id_str)
    .bind(updated_at)
    .bind(&id_str)
    .bind(unit_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "session_unit".into(),
            id: format!("{}:{}", id_str, unit_id),
        });
    }
    Ok(())
}

// ── Collab row structs ────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ThreadRow {
    id: String,
    artifact_id: String,
    revision_id: String,
    anchor: Option<String>,
    status: String,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct MessageRow {
    id: String,
    thread_id: String,
    body: String,
    author: String,
    created_at: String,
}

#[derive(sqlx::FromRow)]
struct ReviewItemRow {
    id: String,
    artifact_id: String,
    revision_id: String,
    anchor: String,
    claim: String,
    reality: String,
    status: String,
    resolution: Option<String>,
    created_at: String,
}

fn row_to_thread(r: ThreadRow) -> crate::Result<crate::collab::CollabThread> {
    use crate::collab::ThreadStatus;
    Ok(crate::collab::CollabThread {
        id: parse_uuid(&r.id)?,
        artifact_id: parse_uuid(&r.artifact_id)?,
        revision_id: r.revision_id,
        anchor: r.anchor,
        status: ThreadStatus::from_str(&r.status)?,
        created_at: parse_dt(&r.created_at)?,
    })
}

fn row_to_message(r: MessageRow) -> crate::Result<crate::collab::CollabMessage> {
    Ok(crate::collab::CollabMessage {
        id: parse_uuid(&r.id)?,
        thread_id: parse_uuid(&r.thread_id)?,
        body: r.body,
        author: r.author,
        created_at: parse_dt(&r.created_at)?,
    })
}

fn row_to_review_item(r: ReviewItemRow) -> crate::Result<crate::collab::ReviewItem> {
    use crate::collab::ReviewItemStatus;
    Ok(crate::collab::ReviewItem {
        id: parse_uuid(&r.id)?,
        artifact_id: parse_uuid(&r.artifact_id)?,
        revision_id: r.revision_id,
        anchor: r.anchor,
        claim: r.claim,
        reality: r.reality,
        status: ReviewItemStatus::from_str(&r.status)?,
        resolution: r.resolution,
        created_at: parse_dt(&r.created_at)?,
    })
}

// ── Thread CRUD ───────────────────────────────────────────────────────────────

pub async fn insert_thread(
    pool: &SqlitePool,
    t: &crate::collab::CollabThread,
) -> crate::Result<()> {
    let id = t.id.to_string();
    let artifact_id = t.artifact_id.to_string();
    let status = t.status.as_str();
    let created_at = t.created_at.to_rfc3339();
    sqlx::query!(
        "INSERT INTO threads (id, artifact_id, revision_id, anchor, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
        id,
        artifact_id,
        t.revision_id,
        t.anchor,
        status,
        created_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_thread_by_id(
    pool: &SqlitePool,
    id: &Uuid,
) -> crate::Result<crate::collab::CollabThread> {
    let id_str = id.to_string();
    let row = sqlx::query_as!(
        ThreadRow,
        "SELECT id, artifact_id, revision_id, anchor, status, created_at \
         FROM threads WHERE id = ?",
        id_str,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::Error::NotFound {
        entity: "thread".into(),
        id: id_str,
    })?;
    row_to_thread(row)
}

pub async fn list_threads_for_artifact(
    pool: &SqlitePool,
    revision_id: &str,
) -> crate::Result<Vec<crate::collab::CollabThread>> {
    let rows = sqlx::query_as::<_, ThreadRow>(
        "SELECT id, artifact_id, revision_id, anchor, status, created_at \
         FROM threads WHERE revision_id = ? ORDER BY created_at, id",
    )
    .bind(revision_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_thread).collect()
}

pub async fn update_thread_status(
    pool: &SqlitePool,
    id: &Uuid,
    status: &crate::collab::ThreadStatus,
) -> crate::Result<()> {
    let id_str = id.to_string();
    let status_str = status.as_str();
    let result = sqlx::query("UPDATE threads SET status = ? WHERE id = ?")
        .bind(status_str)
        .bind(&id_str)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "thread".into(),
            id: id_str,
        });
    }
    Ok(())
}

// ── Message CRUD ──────────────────────────────────────────────────────────────

pub async fn insert_message(
    pool: &SqlitePool,
    m: &crate::collab::CollabMessage,
) -> crate::Result<()> {
    let id = m.id.to_string();
    let thread_id = m.thread_id.to_string();
    let created_at = m.created_at.to_rfc3339();
    sqlx::query!(
        "INSERT INTO messages (id, thread_id, body, author, created_at) \
         VALUES (?, ?, ?, ?, ?)",
        id,
        thread_id,
        m.body,
        m.author,
        created_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_messages_for_thread(
    pool: &SqlitePool,
    thread_id: &Uuid,
) -> crate::Result<Vec<crate::collab::CollabMessage>> {
    let id_str = thread_id.to_string();
    let rows = sqlx::query_as!(
        MessageRow,
        "SELECT id, thread_id, body, author, created_at \
         FROM messages WHERE thread_id = ? ORDER BY created_at, id",
        id_str,
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_message).collect()
}

// ── ReviewItem CRUD ───────────────────────────────────────────────────────────

pub async fn insert_review_item(
    pool: &SqlitePool,
    ri: &crate::collab::ReviewItem,
) -> crate::Result<()> {
    let id = ri.id.to_string();
    let artifact_id = ri.artifact_id.to_string();
    let status = ri.status.as_str();
    let created_at = ri.created_at.to_rfc3339();
    sqlx::query!(
        "INSERT INTO review_items \
         (id, artifact_id, revision_id, anchor, claim, reality, status, resolution, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        artifact_id,
        ri.revision_id,
        ri.anchor,
        ri.claim,
        ri.reality,
        status,
        ri.resolution,
        created_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_review_item_by_id(
    pool: &SqlitePool,
    id: &Uuid,
) -> crate::Result<crate::collab::ReviewItem> {
    let id_str = id.to_string();
    let row = sqlx::query_as!(
        ReviewItemRow,
        "SELECT id, artifact_id, revision_id, anchor, claim, reality, status, resolution, created_at \
         FROM review_items WHERE id = ?",
        id_str,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| crate::Error::NotFound {
        entity: "review_item".into(),
        id: id_str,
    })?;
    row_to_review_item(row)
}

pub async fn list_review_items_for_artifact(
    pool: &SqlitePool,
    revision_id: &str,
) -> crate::Result<Vec<crate::collab::ReviewItem>> {
    let rows = sqlx::query_as::<_, ReviewItemRow>(
        "SELECT id, artifact_id, revision_id, anchor, claim, reality, status, resolution, created_at \
         FROM review_items WHERE revision_id = ? ORDER BY created_at, id",
    )
    .bind(revision_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_review_item).collect()
}

pub async fn patch_review_item(
    pool: &SqlitePool,
    id: &Uuid,
    status: &crate::collab::ReviewItemStatus,
    resolution: Option<&str>,
) -> crate::Result<()> {
    let id_str = id.to_string();
    let status_str = status.as_str();
    let result = sqlx::query(
        "UPDATE review_items SET status = ?, resolution = ? WHERE id = ?",
    )
    .bind(status_str)
    .bind(resolution)
    .bind(&id_str)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(crate::Error::NotFound {
            entity: "review_item".into(),
            id: id_str,
        });
    }
    Ok(())
}

pub async fn count_open_review_items_for_artifact(
    pool: &SqlitePool,
    revision_id: &str,
) -> crate::Result<i64> {
    let row: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM review_items WHERE revision_id = ? AND status = 'open'")
            .bind(revision_id)
            .fetch_one(pool)
            .await?;
    Ok(row.0)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{StageNodeDef, WorkflowGraph};
    use serde_json::json;
    use std::collections::HashMap;

    fn fixed_dt() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    async fn make_test_pool() -> SqlitePool {
        let path = format!("/tmp/oakridge_test_{}.db", Uuid::new_v4());
        crate::db::init_pool(&format!("sqlite:{}", path))
            .await
            .unwrap()
    }

    fn test_project() -> Project {
        Project {
            id: ProjectId(Uuid::new_v4()),
            name: "test-project".into(),
            repo_dir: "/repos/test".into(),
            created_at: fixed_dt(),
        }
    }

    fn test_workflow_def() -> WorkflowDef {
        WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: format!("wf-{}", Uuid::new_v4()),
            version: 1,
            graph: WorkflowGraph {
                stages: HashMap::new(),
                edges: vec![],
            },
            created_at: fixed_dt(),
        }
    }

    fn test_run(def_id: WorkflowDefId) -> WorkflowRun {
        WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def_id,
            project_id: None,
            status: RunStatus::Pending,
            context: json!({}),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        }
    }

    fn test_stage(run_id: WorkflowRunId) -> StageInstance {
        StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id,
            stage_key: "stage1".into(),
            stage_type: "llm".into(),
            status: StageStatus::Pending,
            config: json!({"k": "v"}),
            parked_reason: None,
            parked_meta: None,
            terminal_meta: None,
            external_ref: None,
            started_at: None,
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        }
    }

    fn test_artifact(run_id: WorkflowRunId, si_id: StageInstanceId) -> Artifact {
        Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id,
            stage_instance_id: si_id,
            artifact_type: "text".into(),
            output_name: Some("out".into()),
            label: Some("output".into()),
            body: json!({"content": "hello"}),
            version: 1,
            parent_artifact_id: None,
            created_at: fixed_dt(),
        }
    }

    // ── Round-trip tests ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_project_roundtrip() {
        let pool = make_test_pool().await;
        let p = test_project();
        insert_project(&pool, &p).await.unwrap();
        let got = get_project_by_id(&pool, &p.id).await.unwrap();
        assert_eq!(p, got);
    }

    #[tokio::test]
    async fn test_workflow_def_roundtrip() {
        let pool = make_test_pool().await;
        let d = WorkflowDef {
            id: WorkflowDefId(Uuid::new_v4()),
            name: "test-wf".into(),
            version: 1,
            graph: WorkflowGraph {
                stages: {
                    let mut m = HashMap::new();
                    m.insert(
                        "s1".into(),
                        StageNodeDef {
                            stage_type: "llm".into(),
                            config: json!({"model": "gpt-4"}),
                            inputs: vec![],
                            outputs: vec![],
                        },
                    );
                    m
                },
                edges: vec![],
            },
            created_at: fixed_dt(),
        };
        insert_workflow_def(&pool, &d).await.unwrap();
        let got = get_workflow_def_by_id(&pool, &d.id).await.unwrap();
        assert_eq!(d, got);
    }

    #[tokio::test]
    async fn test_workflow_run_roundtrip() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Running,
            context: json!({"key": "value"}),
            version: 2,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        insert_workflow_run(&pool, &run).await.unwrap();
        let got = get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(run, got);
    }

    #[tokio::test]
    async fn test_workflow_run_with_project_roundtrip() {
        let pool = make_test_pool().await;
        let proj = test_project();
        insert_project(&pool, &proj).await.unwrap();
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: Some(proj.id),
            status: RunStatus::Pending,
            context: json!(null),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        insert_workflow_run(&pool, &run).await.unwrap();
        let got = get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(run, got);
    }

    #[tokio::test]
    async fn test_stage_instance_roundtrip() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            run_id: run.id,
            stage_key: "analyze".into(),
            stage_type: "llm".into(),
            status: StageStatus::Parked,
            config: json!({"model": "gpt-4"}),
            parked_reason: Some("waiting for human gate".into()),
            parked_meta: Some(serde_json::json!({"request_id": "req-1"})),
            terminal_meta: Some(serde_json::json!({"reason": "completed"})),
            external_ref: Some("ext-123".into()),
            started_at: Some(fixed_dt()),
            ended_at: None,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        insert_stage_instance(&pool, &si).await.unwrap();
        let got = get_stage_instance_by_id(&pool, &si.id).await.unwrap();
        assert_eq!(si, got);
    }

    #[tokio::test]
    async fn test_artifact_roundtrip() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();
        let a = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id: run.id,
            stage_instance_id: si.id,
            artifact_type: "report".into(),
            output_name: Some("report_out".into()),
            label: Some("final-report".into()),
            body: json!({"sections": ["intro", "body"]}),
            version: 1,
            parent_artifact_id: None,
            created_at: fixed_dt(),
        };
        insert_artifact(&pool, &a).await.unwrap();
        let got = get_artifact_by_id(&pool, &a.id).await.unwrap();
        assert_eq!(a, got);
    }

    // ── CHECK constraint tests ────────────────────────────────────────────────

    #[tokio::test]
    async fn test_workflow_run_invalid_status_rejected() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let def_id = def.id.0.to_string();
        // Use runtime query (no macro) so arbitrary status strings bypass compile-time checks.
        let result = sqlx::query(
            "INSERT INTO workflow_run \
             (id, workflow_def_id, status, version, created_at, updated_at) \
             VALUES ('bad-run-id', ?, 'invalid_status', 1, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(def_id)
        .execute(&pool)
        .await;
        assert!(
            result.is_err(),
            "invalid workflow_run.status must be rejected"
        );
    }

    #[tokio::test]
    async fn test_stage_instance_invalid_status_rejected() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let run_id = run.id.0.to_string();
        // Use runtime query (no macro) so arbitrary status strings bypass compile-time checks.
        let result = sqlx::query(
            "INSERT INTO stage_instance \
             (id, run_id, stage_key, stage_type, status, config, created_at, updated_at) \
             VALUES ('bad-si-id', ?, 'k', 'llm', 'archived', '{}', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(run_id)
        .execute(&pool)
        .await;
        assert!(
            result.is_err(),
            "invalid stage_instance.status must be rejected"
        );
    }

    #[tokio::test]
    async fn test_stage_instance_unique_per_run_and_stage_key() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        let first = test_stage(run.id);
        let second = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            ..first.clone()
        };

        insert_stage_instance(&pool, &first).await.unwrap();
        let duplicate = insert_stage_instance(&pool, &second).await;
        assert!(
            duplicate.is_err(),
            "duplicate (run_id, stage_key) must be rejected"
        );
    }

    #[tokio::test]
    async fn test_arbitrary_stage_type_and_artifact_type_accepted() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        let si = StageInstance {
            stage_type: "my-custom-stage-type-not-in-any-check-list".into(),
            ..test_stage(run.id)
        };
        insert_stage_instance(&pool, &si).await.unwrap();

        let a = Artifact {
            artifact_type: "custom-artifact-type-not-in-any-check-list".into(),
            ..test_artifact(run.id, si.id)
        };
        insert_artifact(&pool, &a).await.unwrap();
    }

    // ── Artifact chain ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_artifact_chain() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        let a1 = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id: run.id,
            stage_instance_id: si.id,
            artifact_type: "text".into(),
            output_name: Some("out".into()),
            label: None,
            body: json!("v1"),
            version: 1,
            parent_artifact_id: None,
            created_at: fixed_dt(),
        };
        insert_artifact(&pool, &a1).await.unwrap();

        let a2 = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            parent_artifact_id: Some(a1.id),
            body: json!("v2"),
            version: 2,
            ..a1.clone()
        };
        let a2_id = a2.id;
        insert_artifact(&pool, &a2).await.unwrap();

        let a3 = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            parent_artifact_id: Some(a2_id),
            body: json!("v3"),
            version: 3,
            ..a1.clone()
        };
        insert_artifact(&pool, &a3).await.unwrap();

        let chain = get_artifact_chain(&pool, &a3.id).await.unwrap();
        assert_eq!(chain.len(), 3);
        assert_eq!(chain[0].id, a3.id);
        assert_eq!(chain[1].id, a2_id);
        assert_eq!(chain[2].id, a1.id);
        assert_eq!(chain[0].version, 3);
        assert_eq!(chain[1].version, 2);
        assert_eq!(chain[2].version, 1);
    }

    #[tokio::test]
    async fn test_artifact_chain_root_id() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        let a1 = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id: run.id,
            stage_instance_id: si.id,
            artifact_type: "text".into(),
            output_name: Some("out".into()),
            label: None,
            body: json!("v1"),
            version: 1,
            parent_artifact_id: None,
            created_at: fixed_dt(),
        };
        insert_artifact(&pool, &a1).await.unwrap();
        let a2 = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            parent_artifact_id: Some(a1.id),
            body: json!("v2"),
            version: 2,
            ..a1.clone()
        };
        insert_artifact(&pool, &a2).await.unwrap();
        let a3 = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            parent_artifact_id: Some(a2.id),
            body: json!("v3"),
            version: 3,
            ..a1.clone()
        };
        insert_artifact(&pool, &a3).await.unwrap();

        // Resolves the root from any point in the chain (and from the root itself).
        assert_eq!(
            get_artifact_chain_root_id(&pool, &a3.id).await.unwrap(),
            a1.id.0.to_string()
        );
        assert_eq!(
            get_artifact_chain_root_id(&pool, &a1.id).await.unwrap(),
            a1.id.0.to_string()
        );
    }

    #[tokio::test]
    async fn test_delete_semantics_for_owned_and_definition_rows() {
        let pool = make_test_pool().await;
        let proj = test_project();
        insert_project(&pool, &proj).await.unwrap();
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = WorkflowRun {
            project_id: Some(proj.id),
            ..test_run(def.id)
        };
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        let root = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            run_id: run.id,
            stage_instance_id: si.id,
            artifact_type: "text".into(),
            output_name: Some("out".into()),
            label: None,
            body: json!("root"),
            version: 1,
            parent_artifact_id: None,
            created_at: fixed_dt(),
        };
        insert_artifact(&pool, &root).await.unwrap();
        let rev = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            parent_artifact_id: Some(root.id),
            body: json!("rev"),
            version: 2,
            ..root.clone()
        };
        insert_artifact(&pool, &rev).await.unwrap();

        let delete_project = sqlx::query("DELETE FROM project WHERE id = ?")
            .bind(proj.id.0.to_string())
            .execute(&pool)
            .await;
        assert!(
            delete_project.is_err(),
            "project deletion must be restricted while referenced"
        );

        let delete_def = sqlx::query("DELETE FROM workflow_def WHERE id = ?")
            .bind(def.id.0.to_string())
            .execute(&pool)
            .await;
        assert!(
            delete_def.is_err(),
            "workflow_def deletion must be restricted while referenced"
        );

        sqlx::query("DELETE FROM workflow_run WHERE id = ?")
            .bind(run.id.0.to_string())
            .execute(&pool)
            .await
            .unwrap();

        assert!(get_stage_instance_by_id(&pool, &si.id).await.is_err());
        assert!(get_artifact_by_id(&pool, &root.id).await.is_err());
        assert!(get_artifact_by_id(&pool, &rev.id).await.is_err());
    }

    #[tokio::test]
    async fn test_parent_artifact_deletion_cascades_to_descendant_revisions() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        let root = test_artifact(run.id, si.id);
        insert_artifact(&pool, &root).await.unwrap();
        let child = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            parent_artifact_id: Some(root.id),
            body: json!("child"),
            version: 2,
            ..root.clone()
        };
        insert_artifact(&pool, &child).await.unwrap();
        let grandchild = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            parent_artifact_id: Some(child.id),
            body: json!("grandchild"),
            version: 3,
            ..root.clone()
        };
        insert_artifact(&pool, &grandchild).await.unwrap();

        sqlx::query("DELETE FROM artifact WHERE id = ?")
            .bind(root.id.0.to_string())
            .execute(&pool)
            .await
            .unwrap();

        assert!(get_artifact_by_id(&pool, &root.id).await.is_err());
        assert!(get_artifact_by_id(&pool, &child.id).await.is_err());
        assert!(get_artifact_by_id(&pool, &grandchild.id).await.is_err());
    }

    // ── List / filter tests ───────────────────────────────────────────────────

    #[tokio::test]
    async fn test_list_workflow_runs_filters() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let proj = test_project();
        insert_project(&pool, &proj).await.unwrap();

        let run_pending = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: Some(proj.id),
            status: RunStatus::Pending,
            context: json!({}),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        insert_workflow_run(&pool, &run_pending).await.unwrap();

        let run_running = WorkflowRun {
            id: WorkflowRunId(Uuid::new_v4()),
            workflow_def_id: def.id,
            project_id: None,
            status: RunStatus::Running,
            context: json!({}),
            version: 1,
            created_at: fixed_dt(),
            updated_at: fixed_dt(),
        };
        insert_workflow_run(&pool, &run_running).await.unwrap();

        let pending = list_workflow_runs(&pool, Some(RunStatus::Pending), None, None)
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, run_pending.id);

        let by_def = list_workflow_runs(&pool, None, Some(&def.id), None)
            .await
            .unwrap();
        assert_eq!(by_def.len(), 2);

        let by_proj = list_workflow_runs(&pool, None, None, Some(&proj.id))
            .await
            .unwrap();
        assert_eq!(by_proj.len(), 1);
        assert_eq!(by_proj[0].id, run_pending.id);

        let all = list_workflow_runs(&pool, None, None, None).await.unwrap();
        assert_eq!(all.len(), 2);

        let active = list_active_runs(&pool).await.unwrap();
        assert_eq!(active.len(), 2);
    }

    #[tokio::test]
    async fn test_list_operator_run_summaries_aggregates_stage_state() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let empty_def = test_workflow_def();
        insert_workflow_def(&pool, &empty_def).await.unwrap();

        let run = WorkflowRun {
            status: RunStatus::Running,
            ..test_run(def.id)
        };
        insert_workflow_run(&pool, &run).await.unwrap();
        let empty_run = WorkflowRun {
            workflow_def_id: empty_def.id,
            status: RunStatus::Done,
            ..test_run(empty_def.id)
        };
        insert_workflow_run(&pool, &empty_run).await.unwrap();

        let running_stage = StageInstance {
            stage_key: "build".into(),
            status: StageStatus::Running,
            ..test_stage(run.id)
        };
        insert_stage_instance(&pool, &running_stage).await.unwrap();
        let parked_stage = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            stage_key: "review".into(),
            status: StageStatus::Parked,
            ..test_stage(run.id)
        };
        insert_stage_instance(&pool, &parked_stage).await.unwrap();

        let summaries = list_operator_run_summaries(&pool, None).await.unwrap();
        assert_eq!(summaries.len(), 2);

        let run_summary = summaries
            .iter()
            .find(|summary| summary.run_id == run.id)
            .unwrap();
        assert_eq!(run_summary.workflow_name, def.name);
        assert_eq!(run_summary.status, RunStatus::Running);
        assert_eq!(run_summary.current_stage.as_deref(), Some("review"));
        assert_eq!(run_summary.parked_count, 1);
        assert_eq!(run_summary.updated_at, run.updated_at);

        let empty_summary = summaries
            .iter()
            .find(|summary| summary.run_id == empty_run.id)
            .unwrap();
        assert_eq!(empty_summary.workflow_name, empty_def.name);
        assert_eq!(empty_summary.status, RunStatus::Done);
        assert_eq!(empty_summary.current_stage, None);
        assert_eq!(empty_summary.parked_count, 0);
    }

    #[tokio::test]
    async fn test_mark_workflow_run_failed_if_pending_only_updates_pending_rows() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();

        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        let updated = mark_workflow_run_failed_if_pending(&pool, &run.id)
            .await
            .unwrap();
        assert!(updated, "pending row should be marked failed");

        let stored = get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(stored.status, RunStatus::Failed);

        let updated_again = mark_workflow_run_failed_if_pending(&pool, &run.id)
            .await
            .unwrap();
        assert!(
            !updated_again,
            "non-pending row should not be touched twice"
        );
    }

    #[tokio::test]
    async fn test_list_artifacts_filter() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        let a1 = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            artifact_type: "text".into(),
            output_name: Some("out_text".into()),
            body: json!("t"),
            label: None,
            ..test_artifact(run.id, si.id)
        };
        let a2 = Artifact {
            id: ArtifactId(Uuid::new_v4()),
            artifact_type: "json".into(),
            output_name: Some("out_json".into()),
            body: json!({}),
            label: None,
            ..test_artifact(run.id, si.id)
        };
        insert_artifact(&pool, &a1).await.unwrap();
        insert_artifact(&pool, &a2).await.unwrap();

        let text = list_artifacts_for_run(&pool, &run.id, Some("text"))
            .await
            .unwrap();
        assert_eq!(text.len(), 1);
        assert_eq!(text[0].id, a1.id);

        let all = list_artifacts_for_run(&pool, &run.id, None).await.unwrap();
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn test_list_stage_instances_and_parked() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        let si_pending = test_stage(run.id);
        let si_parked = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            stage_key: "stage2".into(),
            status: StageStatus::Parked,
            parked_reason: Some("waiting".into()),
            terminal_meta: None,
            ..test_stage(run.id)
        };
        insert_stage_instance(&pool, &si_pending).await.unwrap();
        insert_stage_instance(&pool, &si_parked).await.unwrap();

        let for_run = list_stage_instances_for_run(&pool, &run.id).await.unwrap();
        assert_eq!(for_run.len(), 2);

        let parked = list_parked_stage_instances(&pool).await.unwrap();
        assert_eq!(parked.len(), 1);
        assert_eq!(parked[0].id, si_parked.id);
    }

    #[tokio::test]
    async fn test_set_stage_instance_external_ref() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        set_stage_instance_external_ref(&pool, &si.id, Some("ext-123".into()))
            .await
            .unwrap();

        let got = get_stage_instance_by_id(&pool, &si.id).await.unwrap();
        assert_eq!(got.external_ref.as_deref(), Some("ext-123"));
    }

    #[tokio::test]
    async fn test_update_workflow_run_status() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        update_workflow_run_status(&pool, &run.id, RunStatus::Done)
            .await
            .unwrap();
        let got = get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(got.status, RunStatus::Done);
    }

    #[tokio::test]
    async fn test_update_stage_instance_status() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        update_stage_instance_status(
            &pool,
            &si.id,
            StageStatus::Parked,
            Some("gate waiting".into()),
            None,
            Some(fixed_dt()),
            None,
        )
        .await
        .unwrap();
        let got = get_stage_instance_by_id(&pool, &si.id).await.unwrap();
        assert_eq!(got.status, StageStatus::Parked);
        assert_eq!(got.parked_reason, Some("gate waiting".into()));
        assert_eq!(got.started_at, Some(fixed_dt()));
        assert_eq!(got.ended_at, None);
    }

    #[tokio::test]
    async fn test_update_stage_instance_status_with_terminal_meta() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        update_stage_instance_status_with_terminal_meta(
            &pool,
            &si.id,
            StageStatus::Failed,
            None,
            Some(json!({"reason": "boom"})),
            None,
            Some(fixed_dt()),
        )
        .await
        .unwrap();

        let got = get_stage_instance_by_id(&pool, &si.id).await.unwrap();
        assert_eq!(got.status, StageStatus::Failed);
        assert_eq!(got.terminal_meta, Some(json!({"reason": "boom"})));
        assert_eq!(got.ended_at, Some(fixed_dt()));
    }

    #[tokio::test]
    async fn test_busy_timeout_is_configured() {
        let pool = make_test_pool().await;
        let busy_timeout_ms: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(busy_timeout_ms, 5_000);
    }

    #[tokio::test]
    async fn park_stage_instance_as_stuck_cas() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        let si = StageInstance {
            status: StageStatus::Running,
            ..test_stage(run.id)
        };
        insert_stage_instance(&pool, &si).await.unwrap();

        let meta = json!({"kind": "stuck_timeout", "timeout_seconds": 3600});

        // First attempt: stage is Running → should park.
        let parked = park_stage_instance_as_stuck(&pool, &si.id, &meta)
            .await
            .unwrap();
        assert!(parked, "first CAS must succeed when stage is running");

        let got = get_stage_instance_by_id(&pool, &si.id).await.unwrap();
        assert_eq!(got.status, StageStatus::Parked);
        assert_eq!(got.parked_reason.as_deref(), Some("stuck_timeout"));
        assert_eq!(got.parked_meta, Some(meta.clone()));

        // Second attempt: stage is now Parked → CAS must fail.
        let parked_again = park_stage_instance_as_stuck(&pool, &si.id, &meta)
            .await
            .unwrap();
        assert!(
            !parked_again,
            "second CAS must be a no-op when stage is already parked"
        );
    }

    #[tokio::test]
    async fn list_running_stage_instances_older_than_filters_correctly() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        let past = DateTime::parse_from_rfc3339("2020-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let future = DateTime::parse_from_rfc3339("2099-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let old_running = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            stage_key: "old_running".into(),
            status: StageStatus::Running,
            updated_at: past,
            ..test_stage(run.id)
        };
        let new_running = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            stage_key: "new_running".into(),
            status: StageStatus::Running,
            updated_at: future,
            ..test_stage(run.id)
        };
        let parked_old = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            stage_key: "parked_old".into(),
            status: StageStatus::Parked,
            updated_at: past,
            ..test_stage(run.id)
        };
        insert_stage_instance(&pool, &old_running).await.unwrap();
        insert_stage_instance(&pool, &new_running).await.unwrap();
        insert_stage_instance(&pool, &parked_old).await.unwrap();

        let cutoff = DateTime::parse_from_rfc3339("2025-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let stale = list_running_stage_instances_older_than(&pool, cutoff)
            .await
            .unwrap();

        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, old_running.id);
    }

    #[tokio::test]
    async fn test_session_unit_crud() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        let now = fixed_dt();
        let unit = crate::types::SessionUnit {
            stage_instance_id: si.id,
            unit_id: "0".to_string(),
            params: None,
            depends_on: vec![],
            external_ref: None,
            worktree_branch: None,
            worktree_path: None,
            worktree_base_ref: None,
            status: crate::types::UnitStatus::Pending,
            gate_state: None,
            artifact_id: None,
            terminal_meta: None,
            created_at: now,
            updated_at: now,
        };

        // Insert
        upsert_session_unit(&pool, &unit).await.unwrap();

        // Read back and verify fields
        let got = get_session_unit(&pool, &si.id, "0").await.unwrap();
        assert_eq!(got.stage_instance_id, si.id);
        assert_eq!(got.unit_id, "0");
        assert_eq!(got.status, crate::types::UnitStatus::Pending);
        assert!(got.params.is_none());
        assert!(got.depends_on.is_empty());
        assert!(got.external_ref.is_none());

        // Update status
        set_session_unit_status(&pool, &si.id, "0", crate::types::UnitStatus::Running, None)
            .await
            .unwrap();
        let got2 = get_session_unit(&pool, &si.id, "0").await.unwrap();
        assert_eq!(got2.status, crate::types::UnitStatus::Running);

        // Update external_ref
        set_session_unit_external_ref(
            &pool,
            &si.id,
            "0",
            Some("sid-abc".into()),
            Some("branch-1".into()),
            Some("/worktrees/wt1".into()),
            Some("abc123".into()),
        )
        .await
        .unwrap();
        let got3 = get_session_unit(&pool, &si.id, "0").await.unwrap();
        assert_eq!(got3.external_ref.as_deref(), Some("sid-abc"));
        assert_eq!(got3.worktree_branch.as_deref(), Some("branch-1"));

        // Set done status
        set_session_unit_status(
            &pool,
            &si.id,
            "0",
            crate::types::UnitStatus::Done,
            Some(json!({"reason": "complete"})),
        )
        .await
        .unwrap();
        let got4 = get_session_unit(&pool, &si.id, "0").await.unwrap();
        assert_eq!(got4.status, crate::types::UnitStatus::Done);
        assert_eq!(got4.terminal_meta, Some(json!({"reason": "complete"})));

        // List units for stage
        let units = list_session_units_for_stage(&pool, &si.id).await.unwrap();
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].unit_id, "0");

        // Cascade delete: deleting stage_instance should delete units
        sqlx::query("DELETE FROM workflow_run WHERE id = ?")
            .bind(run.id.0.to_string())
            .execute(&pool)
            .await
            .unwrap();
        let units_after_delete = list_session_units_for_stage(&pool, &si.id).await.unwrap();
        assert!(units_after_delete.is_empty(), "units must cascade-delete with stage_instance");
    }

    #[tokio::test]
    async fn operator_run_summaries_is_stuck_reflects_stuck_timeout_parked_reason() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();

        let run = WorkflowRun {
            status: RunStatus::Running,
            ..test_run(def.id)
        };
        insert_workflow_run(&pool, &run).await.unwrap();

        // Normal parked stage: is_stuck must be false.
        let normal_parked = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            stage_key: "gate".into(),
            status: StageStatus::Parked,
            parked_reason: Some("waiting_gate".into()),
            ..test_stage(run.id)
        };
        insert_stage_instance(&pool, &normal_parked).await.unwrap();

        let summaries = list_operator_run_summaries(&pool, None).await.unwrap();
        let s = summaries.iter().find(|s| s.run_id == run.id).unwrap();
        assert!(!s.is_stuck, "normal park must not set is_stuck");

        // Add a stuck-parked stage: is_stuck must flip to true.
        let stuck_parked = StageInstance {
            id: StageInstanceId(Uuid::new_v4()),
            stage_key: "long_running".into(),
            status: StageStatus::Parked,
            parked_reason: Some("stuck_timeout".into()),
            ..test_stage(run.id)
        };
        insert_stage_instance(&pool, &stuck_parked).await.unwrap();

        let summaries2 = list_operator_run_summaries(&pool, None).await.unwrap();
        let s2 = summaries2.iter().find(|s| s.run_id == run.id).unwrap();
        assert!(s2.is_stuck, "stuck_timeout parked stage must set is_stuck");
    }
}

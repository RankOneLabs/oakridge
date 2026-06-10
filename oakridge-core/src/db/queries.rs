// Regenerate .sqlx/ offline metadata:
//   DATABASE_URL=sqlite:/tmp/oakridge_prepare.db \
//     cargo sqlx migrate run --source src/db/migrations && \
//     cargo sqlx prepare
// Run from the oakridge-core directory.

use sqlx::SqlitePool;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use serde_json::Value;
use crate::types::{
    Artifact, ArtifactId, Project, ProjectId, RunStatus, StageInstance,
    StageInstanceId, StageStatus, WorkflowDef, WorkflowDefId, WorkflowRun, WorkflowRunId,
};

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
struct StageInstanceRow {
    id: String,
    run_id: String,
    stage_key: String,
    stage_type: String,
    status: String,
    config: String,
    parked_reason: Option<String>,
    parked_meta: Option<String>,
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
    Uuid::parse_str(s)
        .map_err(|e| crate::Error::Validation(format!("invalid uuid '{}': {}", s, e)))
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
        project_id: r.project_id.as_deref().map(parse_uuid).transpose()?.map(ProjectId),
        status: str_to_enum(r.status)?,
        context: opt_json(r.context)?,
        version: r.version as i32,
        created_at: parse_dt(&r.created_at)?,
        updated_at: parse_dt(&r.updated_at)?,
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
        parked_meta: r.parked_meta.map(|s| serde_json::from_str(&s)).transpose()?,
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
        parent_artifact_id: r.parent_artifact_id.as_deref().map(parse_uuid).transpose()?.map(ArtifactId),
        created_at: parse_dt(&r.created_at)?,
    })
}

// ── Project ───────────────────────────────────────────────────────────────────

pub async fn insert_project(pool: &SqlitePool, p: &Project) -> crate::Result<()> {
    let id = p.id.0.to_string();
    let repo_dir = p.repo_dir.to_str().ok_or_else(|| {
        crate::Error::Validation(format!("repo_dir is not valid UTF-8: {:?}", p.repo_dir))
    })?.to_string();
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
        qb.push(" AND workflow_def_id = ").push_bind(d.0.to_string());
    }
    if let Some(p) = project_id {
        qb.push(" AND project_id = ").push_bind(p.0.to_string());
    }
    qb.push(" ORDER BY created_at, id");
    let rows = qb.build_query_as::<WorkflowRunRow>().fetch_all(pool).await?;
    rows.into_iter().map(row_to_workflow_run).collect()
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
    let parked_meta = s.parked_meta.as_ref().map(serde_json::to_string).transpose()?;
    let started_at = s.started_at.map(|t| t.to_rfc3339());
    let ended_at = s.ended_at.map(|t| t.to_rfc3339());
    let created_at = s.created_at.to_rfc3339();
    let updated_at = s.updated_at.to_rfc3339();
    sqlx::query!(
        "INSERT INTO stage_instance \
         (id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, external_ref, \
          started_at, ended_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        run_id,
        s.stage_key,
        s.stage_type,
        status,
        config,
        s.parked_reason,
        parked_meta,
        s.external_ref,
        started_at,
        ended_at,
        created_at,
        updated_at,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_stage_instance_by_id(
    pool: &SqlitePool,
    id: &StageInstanceId,
) -> crate::Result<StageInstance> {
    let id_str = id.0.to_string();
    let row = sqlx::query_as!(
        StageInstanceRow,
        "SELECT id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, external_ref, \
         started_at, ended_at, created_at, updated_at \
         FROM stage_instance WHERE id = ?",
        id_str,
    )
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
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let status_str = enum_to_str(&status)?;
    let updated_at = Utc::now().to_rfc3339();
    let started_at_str = started_at.map(|t| t.to_rfc3339());
    let ended_at_str = ended_at.map(|t| t.to_rfc3339());
    // A terminal row ('done'/'failed') is frozen: status, parked_reason and
    // ended_at are preserved against any later write. The delegated_session
    // execute() reorder makes a stage live *before* the POST to kbbl so a fast
    // callback can land a real terminal status while execute() is still running;
    // scheduler.rs then turns any later execute() Err into a raw Failed write
    // through this helper. Without the guard that fallback would demote a row the
    // callback already marked done (state regression) — the CASE expressions keep
    // the existing terminal values. The guard is a no-op for the first, legitimate
    // transition to terminal (current status is still non-terminal then). updated_at
    // always advances so the touch is observable; rows_affected stays 1 (WHERE id)
    // so a frozen no-op does not surface as NotFound.
    //
    // started_at uses COALESCE(?, started_at): a None arg preserves any existing
    // start time rather than clobbering it to NULL, so a Failed stage keeps the
    // time it actually started. Callers that intend to set a start time
    // (set_status) pass Some(..) and COALESCE returns it unchanged.
    let result = sqlx::query!(
        "UPDATE stage_instance \
         SET status = CASE WHEN status IN ('done', 'failed') THEN status ELSE ? END, \
             parked_reason = CASE WHEN status IN ('done', 'failed') THEN parked_reason ELSE ? END, \
             started_at = COALESCE(CAST(? AS TEXT), started_at), \
             ended_at = CASE WHEN status IN ('done', 'failed') THEN ended_at ELSE ? END, \
             updated_at = ? \
         WHERE id = ?",
        status_str,
        parked_reason,
        started_at_str,
        ended_at_str,
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

/// Set (or clear, with `None`) the structured park metadata an executor attaches
/// while a stage is parked. Kept independent of `update_stage_instance_status` so
/// it does not disturb that function's many call sites.
pub async fn set_stage_instance_parked_meta(
    pool: &SqlitePool,
    id: &StageInstanceId,
    parked_meta: Option<Value>,
) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let parked_meta = parked_meta.as_ref().map(serde_json::to_string).transpose()?;
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

pub async fn set_stage_instance_external_ref(
    pool: &SqlitePool,
    id: &StageInstanceId,
    external_ref: Option<&str>,
) -> crate::Result<()> {
    let id_str = id.0.to_string();
    let updated_at = Utc::now().to_rfc3339();
    let result = sqlx::query!(
        "UPDATE stage_instance SET external_ref = ?, updated_at = ? WHERE id = ?",
        external_ref,
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

pub async fn update_stage_instance_status_if_current_status(
    pool: &SqlitePool,
    id: &StageInstanceId,
    expected_status: StageStatus,
    status: StageStatus,
    parked_reason: Option<String>,
    started_at: Option<DateTime<Utc>>,
    ended_at: Option<DateTime<Utc>>,
) -> crate::Result<bool> {
    let id_str = id.0.to_string();
    let expected_status_str = enum_to_str(&expected_status)?;
    let status_str = enum_to_str(&status)?;
    let updated_at = Utc::now().to_rfc3339();
    let started_at_str = started_at.map(|t| t.to_rfc3339());
    let ended_at_str = ended_at.map(|t| t.to_rfc3339());
    let result = sqlx::query(
        "UPDATE stage_instance \
         SET status = ?, parked_reason = ?, started_at = ?, ended_at = ?, updated_at = ? \
         WHERE id = ? AND status = ?",
    )
    .bind(status_str)
    .bind(parked_reason)
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
    let rows = sqlx::query_as!(
        StageInstanceRow,
        "SELECT id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, external_ref, \
         started_at, ended_at, created_at, updated_at \
         FROM stage_instance WHERE run_id = ?",
        run_id_str,
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_stage_instance).collect()
}

pub async fn list_parked_stage_instances(pool: &SqlitePool) -> crate::Result<Vec<StageInstance>> {
    let rows = sqlx::query_as!(
        StageInstanceRow,
        "SELECT id, run_id, stage_key, stage_type, status, config, parked_reason, parked_meta, external_ref, \
         started_at, ended_at, created_at, updated_at \
         FROM stage_instance WHERE status = 'parked'",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_stage_instance).collect()
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
            return Err(crate::Error::Validation(
                format!("artifact chain contains a cycle at {}", aid.0),
            ));
        }
        let artifact = get_artifact_by_id(pool, &aid).await?;
        current_id = artifact.parent_artifact_id;
        chain.push(artifact);
    }
    Ok(chain)
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{StageNodeDef, WorkflowGraph};
    use std::collections::HashMap;
    use serde_json::json;

    fn fixed_dt() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    async fn make_test_pool() -> SqlitePool {
        let path = format!("/tmp/oakridge_test_{}.db", Uuid::new_v4());
        crate::db::init_pool(&format!("sqlite:{}", path)).await.unwrap()
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
            graph: WorkflowGraph { stages: HashMap::new(), edges: vec![] },
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
                    m.insert("s1".into(), StageNodeDef {
                        stage_type: "llm".into(),
                        config: json!({"model": "gpt-4"}),
                        inputs: vec![],
                        outputs: vec![],
                    });
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
        assert!(result.is_err(), "invalid workflow_run.status must be rejected");
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
        assert!(result.is_err(), "invalid stage_instance.status must be rejected");
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
        assert!(duplicate.is_err(), "duplicate (run_id, stage_key) must be rejected");
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
        assert!(delete_project.is_err(), "project deletion must be restricted while referenced");

        let delete_def = sqlx::query("DELETE FROM workflow_def WHERE id = ?")
            .bind(def.id.0.to_string())
            .execute(&pool)
            .await;
        assert!(delete_def.is_err(), "workflow_def deletion must be restricted while referenced");

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

        let pending = list_workflow_runs(&pool, Some(RunStatus::Pending), None, None).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, run_pending.id);

        let by_def = list_workflow_runs(&pool, None, Some(&def.id), None).await.unwrap();
        assert_eq!(by_def.len(), 2);

        let by_proj = list_workflow_runs(&pool, None, None, Some(&proj.id)).await.unwrap();
        assert_eq!(by_proj.len(), 1);
        assert_eq!(by_proj[0].id, run_pending.id);

        let all = list_workflow_runs(&pool, None, None, None).await.unwrap();
        assert_eq!(all.len(), 2);

        let active = list_active_runs(&pool).await.unwrap();
        assert_eq!(active.len(), 2);
    }

    #[tokio::test]
    async fn test_mark_workflow_run_failed_if_pending_only_updates_pending_rows() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();

        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        let updated = mark_workflow_run_failed_if_pending(&pool, &run.id).await.unwrap();
        assert!(updated, "pending row should be marked failed");

        let stored = get_workflow_run_by_id(&pool, &run.id).await.unwrap();
        assert_eq!(stored.status, RunStatus::Failed);

        let updated_again = mark_workflow_run_failed_if_pending(&pool, &run.id).await.unwrap();
        assert!(!updated_again, "non-pending row should not be touched twice");
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

        let text = list_artifacts_for_run(&pool, &run.id, Some("text")).await.unwrap();
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
    async fn test_update_workflow_run_status() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();

        update_workflow_run_status(&pool, &run.id, RunStatus::Done).await.unwrap();
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

    /// A terminal row is frozen: a later non-terminal write (the raw Err→Failed
    /// path in the scheduler, or a stray Running) must not demote a status a fast
    /// kbbl callback already set, nor clobber its ended_at. The first transition
    /// into terminal still succeeds; only writes against an already-terminal row
    /// are no-ops on the frozen fields.
    #[tokio::test]
    async fn test_terminal_status_is_not_demoted() {
        let pool = make_test_pool().await;
        let def = test_workflow_def();
        insert_workflow_def(&pool, &def).await.unwrap();
        let run = test_run(def.id);
        insert_workflow_run(&pool, &run).await.unwrap();
        let si = test_stage(run.id);
        insert_stage_instance(&pool, &si).await.unwrap();

        // A fast callback marks the stage done with a real completion time.
        let done_at = fixed_dt();
        update_stage_instance_status(
            &pool,
            &si.id,
            StageStatus::Done,
            None,
            Some(fixed_dt()),
            Some(done_at),
        )
        .await
        .unwrap();

        // The scheduler's raw Err→Failed fallback fires afterwards: status=Failed,
        // parked_reason=None, started_at=None, a *later* ended_at. It must not win.
        let later = DateTime::parse_from_rfc3339("2026-02-02T00:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);
        let res = update_stage_instance_status(
            &pool,
            &si.id,
            StageStatus::Failed,
            Some("execute() returned Err".into()),
            None,
            Some(later),
        )
        .await;
        // The write is a row-matching no-op on frozen fields, not a NotFound.
        assert!(res.is_ok());

        let got = get_stage_instance_by_id(&pool, &si.id).await.unwrap();
        assert_eq!(got.status, StageStatus::Done, "terminal status must not be demoted");
        assert_eq!(got.parked_reason, None);
        assert_eq!(got.started_at, Some(fixed_dt()), "started_at preserved");
        assert_eq!(got.ended_at, Some(done_at), "original completion time preserved");
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
}

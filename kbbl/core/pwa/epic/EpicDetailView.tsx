import type { ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { responseError } from "../lib/http";
import { useServerConfig } from "../hooks/useServerConfig";

import { StageStrip } from "./StageStrip";
import { DiscrepanciesEditor } from "./DiscrepanciesEditor";
import { PlanDrilldown } from "./PlanDrilldown";
import { BuildDrilldown } from "./BuildDrilldown";
import { ReviewDrilldown } from "./ReviewDrilldown";

type EpicStatus = "pending" | "active" | "complete" | "archived";
type EpicStage = "spec" | "plan" | "build" | "assess";
type SpecInternalStatus = "analyzing" | "discrepancies" | "review" | "approved";
type PlanStatus = "pending_approval" | "approved" | "rejected" | "superseded";
type CohortStatus = "waiting" | "planned" | "briefing" | "brief_review" | "building" | "ready_to_build" | "awaiting_merge" | "done" | "blocked";

interface EpicDetailData {
  epic: {
    id: string;
    project_id: string;
    title: string;
    status: EpicStatus;
    current_stage: EpicStage;
    created_at: string;
    planner_runtime: string | null;
    planner_model: string | null;
    build_runtime: string | null;
    build_model: string | null;
  };
  spec: {
    id: string;
    internal_status: SpecInternalStatus;
  } | null;
  plan: {
    id: string;
    status: PlanStatus;
  } | null;
  cohorts: Array<{
    id: string;
    title: string;
    position: number;
    status: CohortStatus;
  }>;
  assessment_present: boolean;
}

interface EpicDetailViewProps {
  epic_id: string;
}

export function EpicDetailView({ epic_id }: EpicDetailViewProps) {
  const queryClient = useQueryClient();
  const config = useServerConfig();

  const query = useQuery({
    queryKey: ["epic", epic_id],
    queryFn: async (): Promise<EpicDetailData> => {
      const res = await fetch(`/epics/${encodeURIComponent(epic_id)}`);
      if (!res.ok) throw await responseError(res, "epic");
      return (await res.json()) as EpicDetailData;
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (newStatus: EpicStatus) => {
      const res = await fetch(`/epics/${encodeURIComponent(epic_id)}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw await responseError(res, "status");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["epic", epic_id] });
      const projectId = query.data?.epic.project_id;
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ["epics", projectId] });
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/epics/${encodeURIComponent(epic_id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw await responseError(res, "delete");
    },
    onSuccess: () => {
      const projectId = query.data?.epic.project_id;
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ["epics", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["specs", { projectId }] });
      }
      window.location.hash = projectId ? `repo/${projectId}` : "";
    },
  });

  const onDelete = () => {
    if (
      !window.confirm(
        "Delete this Epic? This removes the spec, plan, cohorts, briefs, and assessment. Session transcripts are preserved.",
      )
    )
      return;
    deleteMutation.mutate();
  };

  if (query.error instanceof Error) {
    return (
      <div className="epic-detail">
        {/* project_id unknown at this point — fall back to session root */}
        <button type="button" className="epic-detail__back" onClick={() => { window.location.hash = ""; }}>
          ← Back
        </button>
        <div className="epic-detail__error" role="alert">
          {query.error.message}
        </div>
      </div>
    );
  }

  if (query.isPending || !query.data) {
    return (
      <div className="epic-detail">
        {/* project_id unknown at this point — fall back to session root */}
        <button type="button" className="epic-detail__back" onClick={() => { window.location.hash = ""; }}>
          ← Back
        </button>
        <div>Loading…</div>
      </div>
    );
  }

  const { epic, spec, plan, cohorts, assessment_present } = query.data;

  const plannerRuntime = epic.planner_runtime ?? config?.stageDefaults.planner.runtime ?? '—';
  const plannerModel = epic.planner_model ?? config?.stageDefaults.planner.model ?? '—';
  const buildRuntime = epic.build_runtime ?? config?.stageDefaults.build.runtime ?? '—';
  const buildModel = epic.build_model ?? config?.stageDefaults.build.model ?? '—';

  let drilldown: ReactNode = null;
  if (epic.current_stage === "spec" && spec) {
    drilldown = <DiscrepanciesEditor spec_id={spec.id} epic_id={epic_id} />;
  } else if (epic.current_stage === "plan" && plan) {
    drilldown = <PlanDrilldown plan={plan} />;
  } else if (epic.current_stage === "build") {
    drilldown = <BuildDrilldown cohorts={cohorts} />;
  } else if (epic.current_stage === "assess") {
    drilldown = (
      <ReviewDrilldown plan_id={plan?.id ?? null} assessment_present={assessment_present} />
    );
  }

  const mutationErr =
    archiveMutation.error instanceof Error
      ? archiveMutation.error.message
      : deleteMutation.error instanceof Error
        ? deleteMutation.error.message
        : null;

  return (
    <div className="epic-detail">
      <header className="epic-detail__header">
        <button
          type="button"
          className="epic-detail__back"
          onClick={() => {
            window.location.hash = `repo/${epic.project_id}`;
          }}
        >
          ← Back
        </button>
        <div className="epic-detail__title-block">
          <h1 className="epic-detail__title">{epic.title}</h1>
          <div className="epic-detail__chips">
            <span
              className={`epic-detail__chip epic-detail__chip--status-${epic.status}`}
            >
              {epic.status}
            </span>
            <span
              className={`epic-detail__chip epic-detail__chip--stage-${epic.current_stage}`}
            >
              {epic.current_stage}
            </span>
            <span className="epic-detail__chip epic-detail__chip--routing">
              planner: {plannerRuntime} / {plannerModel}
            </span>
            <span className="epic-detail__chip epic-detail__chip--routing">
              build: {buildRuntime} / {buildModel}
            </span>
          </div>
        </div>
        <div className="epic-detail__actions">
          {epic.status !== "archived" && (
            <button
              type="button"
              className="epic-detail__action-btn"
              disabled={archiveMutation.isPending}
              onClick={() => archiveMutation.mutate("archived")}
            >
              Archive
            </button>
          )}
          {epic.status === "archived" && (
            <button
              type="button"
              className="epic-detail__action-btn"
              disabled={archiveMutation.isPending}
              onClick={() => archiveMutation.mutate("pending")}
            >
              Unarchive
            </button>
          )}
          <button
            type="button"
            className="epic-detail__action-btn epic-detail__action-btn--danger"
            disabled={deleteMutation.isPending}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </header>
      {mutationErr && (
        <div className="epic-detail__mutation-error" role="alert">
          {mutationErr}
        </div>
      )}
      <StageStrip
        current_stage={epic.current_stage}
        spec_internal_status={spec?.internal_status ?? null}
        plan_status={plan?.status ?? null}
        cohorts={cohorts}
        assessment_present={assessment_present}
      />
      {drilldown && <div className="epic-detail__drilldown">{drilldown}</div>}
    </div>
  );
}

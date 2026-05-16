import { useCallback, useEffect, useMemo, type MouseEvent } from "react";
import ReactFlow, {
  Background,
  Controls,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  type OnConnect,
} from "reactflow";
import dagre from "dagre";
import { CohortNode, type CohortNodeData } from "./CohortNode";
import type { Thread, ReviewMode } from "../shared/types";
import type { Cohort, CohortDependency } from "./types";

const NODE_W = 200;
const NODE_H = 80;

const NODE_TYPES: NodeTypes = { cohortNode: CohortNode };

function buildLayout(
  cohorts: Cohort[],
  deps: CohortDependency[],
): { x: number; y: number; id: string }[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 80, nodesep: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  const sorted = [...cohorts].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );

  for (const c of sorted) {
    g.setNode(c.id, { width: NODE_W, height: NODE_H, label: c.id });
  }
  for (const d of deps) {
    g.setEdge(d.from_cohort_id, d.to_cohort_id);
  }

  dagre.layout(g);

  return sorted.map((c) => {
    const n = g.node(c.id);
    return {
      id: c.id,
      x: n ? n.x - NODE_W / 2 : 0,
      y: n ? n.y - NODE_H / 2 : 0,
    };
  });
}

interface DagEditorProps {
  cohorts: Cohort[];
  deps: CohortDependency[];
  threads: Thread[];
  mode: ReviewMode;
  frozen: boolean;
  selectedCohortId: string | null;
  onSelectCohort: (id: string) => void;
  onOpenThread: (anchor: string) => void;
  onAddEdge: (from_cohort_id: string, to_cohort_id: string) => Promise<void>;
  onDeleteEdge: (depId: string) => Promise<void>;
  onUpdatePosition: (cohortId: string, position: number) => Promise<void>;
}

export function DagEditor({
  cohorts,
  deps,
  threads,
  mode,
  frozen,
  selectedCohortId,
  onSelectCohort,
  onOpenThread,
  onAddEdge,
  onDeleteEdge,
  onUpdatePosition,
}: DagEditorProps) {
  const positions = useMemo(() => buildLayout(cohorts, deps), [cohorts, deps]);

  const initialNodes: Node<CohortNodeData>[] = useMemo(
    () =>
      cohorts.map((c) => {
        const pos = positions.find((p) => p.id === c.id) ?? { x: 0, y: 0 };
        return {
          id: c.id,
          type: "cohortNode",
          position: { x: pos.x, y: pos.y },
          data: {
            cohort: c,
            threads,
            mode,
            frozen,
            onSelectCohort,
            onOpenThread,
            isSelected: c.id === selectedCohortId,
          },
        };
      }),
    // rebuild when cohorts, deps layout, selection, or interaction state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cohorts, positions, threads, mode, frozen, selectedCohortId],
  );

  const initialEdges: Edge[] = useMemo(
    () =>
      deps.map((d) => ({
        id: d.id,
        source: d.from_cohort_id,
        target: d.to_cohort_id,
        label: `edge:${d.from_cohort_id}->${d.to_cohort_id}`,
        deletable: mode === "edit" && !frozen,
      })),
    [deps, mode, frozen],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync nodes/edges when props change (e.g. after fetch refresh)
  useEffect(() => { setNodes(initialNodes); }, [initialNodes, setNodes]);
  useEffect(() => { setEdges(initialEdges); }, [initialEdges, setEdges]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (mode !== "edit" || frozen) return;
      if (!connection.source || !connection.target) return;
      void onAddEdge(connection.source, connection.target);
    },
    [mode, frozen, onAddEdge],
  );

  const onNodeDragStop = useCallback(
    (_event: MouseEvent, _draggedNode: Node) => {
      if (mode !== "edit" || frozen) return;
      // Sort all nodes by y position and assign sequential positions to all,
      // so a reorder never leaves duplicate position values on the server.
      const sortedByY = [...nodes].sort(
        (a, b) => a.position.y - b.position.y,
      );
      for (const [idx, node] of sortedByY.entries()) {
        void onUpdatePosition(node.id, idx);
      }
    },
    [mode, frozen, nodes, onUpdatePosition],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) {
        void onDeleteEdge(e.id);
      }
    },
    [onDeleteEdge],
  );

  return (
    <div style={{ flex: 1, height: "100%", minHeight: 400 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={mode === "edit" ? onNodesChange : undefined}
        onEdgesChange={mode === "edit" ? onEdgesChange : undefined}
        onConnect={mode === "edit" && !frozen ? onConnect : undefined}
        onNodeDragStop={mode === "edit" ? onNodeDragStop : undefined}
        onEdgesDelete={mode === "edit" && !frozen ? onEdgesDelete : undefined}
        nodesDraggable={mode === "edit"}
        nodesConnectable={mode === "edit" && !frozen}
        elementsSelectable={mode === "edit"}
        fitView
        fitViewOptions={{ padding: 0.2 }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

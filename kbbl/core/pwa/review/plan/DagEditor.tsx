import ReactFlow, {
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
} from "reactflow";
import "reactflow/dist/style.css";
import Dagre from "dagre";
import { useEffect } from "react";
import { CohortNode, type CohortNodeData } from "./CohortNode";

export interface CohortShape {
  cohort_index: number;
  title: string;
  priority: number;
}

export interface DependencyShape {
  from_cohort_index: number;
  to_cohort_index: number;
}

interface Props {
  cohorts: CohortShape[];
  dependencies: DependencyShape[];
  threadCounts: Record<string, number>;
  selectedCohortIndex: number | null;
  onSelectCohort: (index: number) => void;
  onSelectEdge: (from: number, to: number) => void;
  onConnect?: (from: number, to: number) => void;
  onNodeContextMenu?: (event: React.MouseEvent, cohortIndex: number) => void;
  onEdgeContextMenu?: (event: React.MouseEvent, from: number, to: number) => void;
}

const nodeTypes: NodeTypes = { cohort: CohortNode };

function layoutGraph(cohorts: CohortShape[], deps: DependencyShape[]): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const c of cohorts) {
    const id = String(c.cohort_index);
    g.setNode(id, { width: 180, height: 60 });
  }
  for (const d of deps) {
    g.setEdge(String(d.from_cohort_index), String(d.to_cohort_index));
  }
  Dagre.layout(g);

  const nodes: Node[] = cohorts.map((c) => {
    const pos = g.node(String(c.cohort_index));
    return {
      id: String(c.cohort_index),
      type: "cohort",
      position: { x: (pos?.x ?? 0) - 90, y: (pos?.y ?? 0) - 30 },
      data: { label: c.title, priority: c.priority, commentCount: 0 },
    };
  });

  const edges: Edge[] = deps.map((d) => ({
    id: `edge:${d.from_cohort_index}->${d.to_cohort_index}`,
    source: String(d.from_cohort_index),
    target: String(d.to_cohort_index),
  }));

  return { nodes, edges };
}

export function DagEditor({
  cohorts,
  dependencies,
  threadCounts,
  selectedCohortIndex,
  onSelectCohort,
  onSelectEdge,
  onConnect,
  onNodeContextMenu,
  onEdgeContextMenu,
}: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Re-layout only on structural changes (cohorts/deps); preserves dragged positions
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const { nodes: laidOut, edges: laidOutEdges } = layoutGraph(cohorts, dependencies);
    setNodes(laidOut.map((n) => ({
      ...n,
      data: {
        ...n.data as CohortNodeData,
        commentCount: threadCounts[`cohorts[${n.id}]`] ?? 0,
        selected: Number(n.id) === selectedCohortIndex,
      },
    })));
    setEdges(laidOutEdges);
  }, [cohorts, dependencies, setNodes, setEdges]);

  // Update node metadata (selection, comment counts) without triggering a re-layout
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({
      ...n,
      data: {
        ...n.data as CohortNodeData,
        commentCount: threadCounts[`cohorts[${n.id}]`] ?? 0,
        selected: Number(n.id) === selectedCohortIndex,
      },
    })));
  }, [threadCounts, selectedCohortIndex, setNodes]);

  function handleConnect(connection: Connection) {
    if (connection.source && connection.target && onConnect) {
      setEdges((eds) => addEdge(connection, eds));
      onConnect(Number(connection.source), Number(connection.target));
    }
  }

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_, node) => onSelectCohort(Number(node.id))}
        onEdgeClick={(_, edge) => onSelectEdge(Number(edge.source), Number(edge.target))}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          if (onNodeContextMenu) onNodeContextMenu(e, Number(node.id));
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          if (onEdgeContextMenu) onEdgeContextMenu(e, Number(edge.source), Number(edge.target));
        }}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

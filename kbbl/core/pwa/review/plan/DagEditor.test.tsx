import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DagEditor, COHORT_NODE_LAYOUT } from "./DagEditor";
import { CohortNode, type CohortNodeData } from "./CohortNode";
import type { Cohort, CohortDependency } from "./types";

// ReactFlow needs its CSS side-effects resolved in jsdom.
// We mock the import to avoid "stylesheet" parse errors in jsdom.
vi.mock("reactflow/dist/style.css", () => ({}));

// Stub ReactFlow internals that require a real browser layout engine.
// We test the DagEditor's data-wiring, not ReactFlow's canvas internals.
vi.mock("reactflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("reactflow")>();
  const React = await import("react");

  const MockReactFlow = ({
    nodes,
    edges,
    onNodeDragStop,
    onEdgesDelete,
    onConnect,
  }: {
    nodes: { id: string; data: CohortNodeData }[];
    edges: { id: string; source: string; target: string }[];
    onNodeDragStop?: (
      e: MouseEvent,
      node: { id: string; position: { x: number; y: number } },
    ) => void;
    onEdgesDelete?: (edges: { id: string }[]) => void;
    onConnect?: (connection: {
      source: string;
      target: string;
    }) => void;
  }) => {
    return React.createElement(
      "div",
      { "data-testid": "reactflow-mock" },
      nodes.map((n) =>
        React.createElement(
          "div",
          { key: n.id, "data-testid": `node-${n.id}`, "data-cohort-title": n.data.cohort.title },
          React.createElement(CohortNode, { data: n.data }),
        ),
      ),
      edges.map((e) =>
        React.createElement("div", {
          key: e.id,
          "data-testid": `edge-${e.id}`,
          "data-source": e.source,
          "data-target": e.target,
        }),
      ),
      React.createElement("button", {
        key: "__drag",
        "data-testid": "trigger-drag",
        onClick: () => {
          if (nodes[0] && onNodeDragStop) {
            onNodeDragStop(new MouseEvent("mouseup"), {
              id: nodes[0].id,
              position: { x: 100, y: 300 },
            });
          }
        },
      }),
      React.createElement("button", {
        key: "__delete-edge",
        "data-testid": "trigger-delete-edge",
        onClick: () => {
          if (edges[0] && onEdgesDelete) {
            onEdgesDelete([{ id: edges[0].id }]);
          }
        },
      }),
      React.createElement("button", {
        key: "__connect",
        "data-testid": "trigger-connect",
        onClick: () => {
          if (nodes.length >= 2 && onConnect) {
            onConnect({ source: nodes[0].id, target: nodes[1].id });
          }
        },
      }),
    );
  };

  return {
    ...original,
    default: MockReactFlow,
    Background: () => null,
    Controls: () => null,
    addEdge: original.addEdge,
    useNodesState: (init: unknown[]) => {
      const React = require("react");
      const [nodes, setNodes] = React.useState(init);
      return [nodes, setNodes, () => {}];
    },
    useEdgesState: (init: unknown[]) => {
      const React = require("react");
      const [edges, setEdges] = React.useState(init);
      return [edges, setEdges, () => {}];
    },
    Handle: () => null,
    Position: original.Position,
  };
});

function makeCohort(id: string, title: string, position: number): Cohort {
  return {
    id,
    plan_id: "plan-1",
    title,
    notes: null,
    position,
    status: "waiting",
    created_at: new Date().toISOString(),
  };
}

describe("DagEditor", () => {
  let onUpdatePosition: ReturnType<typeof vi.fn>;
  let onAddEdge: ReturnType<typeof vi.fn>;
  let onDeleteEdge: ReturnType<typeof vi.fn>;

  const cohorts: Cohort[] = [
    makeCohort("c1", "Cohort Alpha", 0),
    makeCohort("c2", "Cohort Beta", 1),
  ];
  const dep: CohortDependency = {
    id: "dep-1",
    from_cohort_id: "c1",
    to_cohort_id: "c2",
  };

  const baseProps = {
    threads: [],
    mode: "edit" as const,
    frozen: false,
    selectedCohortId: null,
    onSelectCohort: vi.fn(),
    onOpenThread: vi.fn(),
  };

  beforeEach(() => {
    onUpdatePosition = vi.fn().mockResolvedValue(undefined);
    onAddEdge = vi.fn().mockResolvedValue(undefined);
    onDeleteEdge = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    );
  });

  it("renders a node for each cohort", () => {
    render(
      <DagEditor
        {...baseProps}
        cohorts={cohorts}
        deps={[dep]}
        onAddEdge={onAddEdge}
        onDeleteEdge={onDeleteEdge}
        onUpdatePosition={onUpdatePosition}
      />,
    );

    expect(screen.getByTestId("node-c1")).toBeTruthy();
    expect(screen.getByTestId("node-c2")).toBeTruthy();
  });

  it("renders an edge for the dependency", () => {
    render(
      <DagEditor
        {...baseProps}
        cohorts={cohorts}
        deps={[dep]}
        onAddEdge={onAddEdge}
        onDeleteEdge={onDeleteEdge}
        onUpdatePosition={onUpdatePosition}
      />,
    );

    const edgeEl = screen.getByTestId("edge-dep-1");
    expect(edgeEl.getAttribute("data-source")).toBe("c1");
    expect(edgeEl.getAttribute("data-target")).toBe("c2");
  });

  it("calls onUpdatePosition when a node is dragged", async () => {
    render(
      <DagEditor
        {...baseProps}
        cohorts={cohorts}
        deps={[dep]}
        onAddEdge={onAddEdge}
        onDeleteEdge={onDeleteEdge}
        onUpdatePosition={onUpdatePosition}
      />,
    );

    screen.getByTestId("trigger-drag").click();

    expect(onUpdatePosition).toHaveBeenCalledWith("c1", expect.any(Number));
  });

  it("calls onSelectCohort when a cohort node is clicked in review mode", () => {
    const onSelectCohort = vi.fn();
    render(
      <DagEditor
        {...baseProps}
        mode="review"
        onSelectCohort={onSelectCohort}
        cohorts={cohorts}
        deps={[dep]}
        onAddEdge={onAddEdge}
        onDeleteEdge={onDeleteEdge}
        onUpdatePosition={onUpdatePosition}
      />,
    );

    const cohortEl = screen.getAllByRole("generic").find(
      (el) => el.classList.contains("cohort-node"),
    );
    expect(cohortEl).toBeTruthy();
    fireEvent.click(cohortEl!);

    expect(onSelectCohort).toHaveBeenCalledWith("c1");
  });

  it("does not call onAddEdge when trigger-connect fires in review mode", () => {
    render(
      <DagEditor
        {...baseProps}
        mode="review"
        cohorts={cohorts}
        deps={[dep]}
        onAddEdge={onAddEdge}
        onDeleteEdge={onDeleteEdge}
        onUpdatePosition={onUpdatePosition}
      />,
    );

    screen.getByTestId("trigger-connect").click();

    expect(onAddEdge).not.toHaveBeenCalled();
  });

  it("renders each .cohort-node with explicit width and height matching COHORT_NODE_LAYOUT", () => {
    render(
      <DagEditor
        {...baseProps}
        cohorts={cohorts}
        deps={[dep]}
        onAddEdge={onAddEdge}
        onDeleteEdge={onDeleteEdge}
        onUpdatePosition={onUpdatePosition}
      />,
    );

    for (const cohort of cohorts) {
      const el = screen.getByLabelText(cohort.title) as HTMLElement;
      expect(el.style.width).toBe(`${COHORT_NODE_LAYOUT.width}px`);
      expect(el.style.height).toBe(`${COHORT_NODE_LAYOUT.height}px`);
    }
  });

  it("cohort with a 200+ char title renders at the same dimensions and exposes full title via title attribute", () => {
    const longTitle = "A".repeat(205);
    const longCohort = makeCohort("c3", longTitle, 2);

    render(
      <DagEditor
        {...baseProps}
        cohorts={[longCohort]}
        deps={[]}
        onAddEdge={onAddEdge}
        onDeleteEdge={onDeleteEdge}
        onUpdatePosition={onUpdatePosition}
      />,
    );

    const node = screen.getByLabelText(longTitle) as HTMLElement;
    expect(node.style.width).toBe(`${COHORT_NODE_LAYOUT.width}px`);
    expect(node.style.height).toBe(`${COHORT_NODE_LAYOUT.height}px`);

    expect(screen.getByTitle(longTitle)).toBeTruthy();
  });
});

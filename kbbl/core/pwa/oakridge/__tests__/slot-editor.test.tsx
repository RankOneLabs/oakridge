import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InputSlotEditor } from "../authoring/SlotEditor";

describe("InputSlotEditor", () => {
  it("edits the collect flag for collection inputs", () => {
    const onChange = vi.fn();
    render(
      <InputSlotEditor
        slots={[{ name: "results", artifact_type: "dev.build_result", collect: false }]}
        artifactTypes={[{ value: "dev.build_result", label: "Build result" }]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Collect producer units" }));
    expect(onChange).toHaveBeenCalledWith([
      { name: "results", artifact_type: "dev.build_result", collect: true },
    ]);
  });
});

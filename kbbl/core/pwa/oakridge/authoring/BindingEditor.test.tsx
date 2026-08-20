// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { BindableEditor, BindingEditor } from "./BindingEditor";
import type { SlotBinding } from "../types";

/**
 * The binding the seeded dev flow gives every cohort: which branch its pull
 * request is expected to target, looked up in the repository refs the
 * provisioning stage emitted, keyed by the repository the cohort builds in.
 */
const expectedPrBase: SlotBinding = {
  from: "input_lookup",
  input_name: "repository_refs",
  collection_key_path: "/artifact/repository_key",
  item_key_path: "/artifact/repository_key",
  value_path: "/artifact/epic_branch",
};

describe("BindingEditor", () => {
  test("an input_lookup binding is shown as itself, with every field it carries", () => {
    render(<BindingEditor label="binding" value={expectedPrBase} onChange={vi.fn()} allowItem />);

    expect((screen.getByLabelText("binding binding source") as HTMLSelectElement).value).toBe("input_lookup");
    expect((screen.getByLabelText("Input name") as HTMLInputElement).value).toBe("repository_refs");
    expect((screen.getByLabelText("Value path") as HTMLInputElement).value).toBe("/artifact/epic_branch");
  });

  /**
   * The regression this file exists for. `input_lookup` was missing from the
   * source list, so the select matched no option; picking any source ran
   * `defaultForSource`, which had no case for it and fell through to a literal.
   * Loading the seeded flow and touching the fan-out editor silently replaced
   * the binding that resolves a cohort's PR base with an empty string.
   */
  test("editing one field of an input_lookup keeps the rest of the binding", () => {
    const onChange = vi.fn();
    render(<BindingEditor label="binding" value={expectedPrBase} onChange={onChange} allowItem />);

    fireEvent.change(screen.getByLabelText("Value path"), { target: { value: "/artifact/base_branch" } });

    expect(onChange).toHaveBeenCalledWith({ ...expectedPrBase, value_path: "/artifact/base_branch" });
  });

  test("both item-keyed lookups are offered inside a fan out, and neither outside one", () => {
    const { unmount } = render(<BindingEditor label="binding" value={{ from: "literal", value: "" }} onChange={vi.fn()} allowItem />);
    const inFanOut = [...(screen.getByLabelText("binding binding source") as HTMLSelectElement).options].map((option) => option.value);
    expect(inFanOut).toContain("input_lookup");
    expect(inFanOut).toContain("context_lookup");
    unmount();

    render(<BindingEditor label="binding" value={{ from: "literal", value: "" }} onChange={vi.fn()} />);
    const scalar = [...(screen.getByLabelText("binding binding source") as HTMLSelectElement).options].map((option) => option.value);
    expect(scalar).toEqual(["literal", "input", "context"]);
  });
});

describe("BindableEditor", () => {
  /**
   * A fan-out `base_ref` is a Bindable, and the seeded flow binds it to the
   * lookup above. `detectMode` called every object a context binding, and the
   * context branch renders only when `from === "context"` — so this binding had
   * no field at all, and the only thing an author could do to it was replace it.
   */
  test("a binding that is not a context path is still shown", () => {
    render(<BindableEditor label="base_ref" value={expectedPrBase} onChange={vi.fn()} allowItem />);

    expect((screen.getByLabelText("base_ref mode") as HTMLSelectElement).value).toBe("binding");
    expect((screen.getByLabelText("Input name") as HTMLInputElement).value).toBe("repository_refs");
  });

  test("a plain context binding keeps its one-field editor", () => {
    render(<BindableEditor label="model" value={{ from: "context", path: "/planner_model" }} onChange={vi.fn()} />);

    expect((screen.getByLabelText("model mode") as HTMLSelectElement).value).toBe("context");
    expect(screen.queryByLabelText("Input name")).toBeNull();
  });

  test("a literal string is untouched by the binding modes", () => {
    render(<BindableEditor label="model" value="opus" onChange={vi.fn()} />);
    expect((screen.getByLabelText("model mode") as HTMLSelectElement).value).toBe("literal");
  });
});

import { createRef } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TextInput } from "./TextInput";
import { TextArea } from "./TextArea";
import { Select } from "./Select";
import { Checkbox } from "./Checkbox";

afterEach(cleanup);

it("forwards native identity, accessibility, class names and refs for every form atom", () => {
  const input = createRef<HTMLInputElement>();
  const area = createRef<HTMLTextAreaElement>();
  const select = createRef<HTMLSelectElement>();
  const checkbox = createRef<HTMLInputElement>();
  const { getByTestId } = render(<>
    <TextInput ref={input} data-testid="input" id="input" aria-label="input" className="extra" />
    <TextArea ref={area} data-testid="area" id="area" aria-label="area" className="extra" variant="editing" />
    <Select ref={select} data-testid="select" id="select" aria-label="select" className="extra"><option value="one">One</option></Select>
    <Checkbox ref={checkbox} type="radio" data-testid="checkbox" id="checkbox" aria-label="checkbox" className="extra" />
  </>);
  for (const [name, ref] of [["input", input], ["area", area], ["select", select], ["checkbox", checkbox]] as const) {
    const element = getByTestId(name);
    expect(element).toBe(ref.current);
    expect(element.id).toBe(name);
    expect(element.getAttribute("aria-label")).toBe(name);
    expect(element.classList.contains("extra")).toBe(true);
    // The atom API promises variant classes before caller-provided classes.
    expect(element.className.trim().split(/\s+/).at(-1)).toBe("extra");
  }
  expect(select.current?.options[0]?.value).toBe("one");
});

it("leaves editing and keyboard behavior with its caller", () => {
  const events: string[] = [];
  const { getByRole } = render(<TextArea onChange={(event) => events.push(event.target.value)} onKeyDown={(event) => events.push(event.key)} />);
  fireEvent.change(getByRole("textbox"), { target: { value: "draft" } });
  fireEvent.keyDown(getByRole("textbox"), { key: "Enter" });
  expect(events).toEqual(["draft", "Enter"]);
});

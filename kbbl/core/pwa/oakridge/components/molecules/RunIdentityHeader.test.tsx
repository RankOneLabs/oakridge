// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { makeRunView } from "../../__fixtures__/read-models";
import { selectRunAccentClass } from "../../lib/run-accent";
import { RunIdentityHeader } from "./RunIdentityHeader";

test("the run header uses its stable accent class", () => {
  const run = makeRunView({ run_id: "run-1" });
  render(<RunIdentityHeader run={run} onBack={() => undefined} />);
  expect(screen.getByTestId("or-run-identity").classList.contains(selectRunAccentClass(run.run_id))).toBe(true);
  expect(screen.getByTestId("or-run-identity").querySelector(".or-run-identity__accent")).toBeTruthy();
});

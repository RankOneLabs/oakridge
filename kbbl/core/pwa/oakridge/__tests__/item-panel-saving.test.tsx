import { json, panel, world, requireControl } from "./item-panel-harness";
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { acknowledged, id, OCCURRENCE, reviewerAnswer } from "../__fixtures__/grading";
import type { ObservationGradeObservationId } from "../grading-contracts/domain/identity";

describe("saving", () => {
  const choose = async (index: number) => fireEvent.click(requireControl(await screen.findAllByTestId("or-your-grade-choice"), index));
  it("sends occurrence, question, submission id, answer and rationale, and no identity", async () => {
    panel();
    await choose(1);
    fireEvent.change(screen.getByTestId("or-your-grade-rationale"), { target: { value: "cited line disagrees" } });
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(world.sent).toEqual([{ task_id: null, question_id: id("assessment_finding.evidence_support"), question_version: "1", submission_id: expect.any(String), answer: "does_not_support", rationale: "cited line disagrees", corrects_observation_id: null }]);
    expect(world.paths.some((path) => path.startsWith(`/oakridge/observation/items/${encodeURIComponent(OCCURRENCE)}/answers`))).toBe(true);
  });
  it("says saved only after the acknowledgment arrives", async () => {
    let answer: (response: Response) => void = () => {};
    world.submit = () => new Promise<Response>((resolve) => { answer = resolve; });
    panel();
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-pending");
    expect(screen.queryByTestId("or-your-grade-saved")).toBeNull();
    answer(json(acknowledged("supports"), 201));
    expect((await screen.findByTestId("or-your-grade-saved")).textContent).toContain("supports");
  });
  it("a refusal and a lost reply never say saved, and each shows its reason", async () => {
    world.submit = () => json({ error: { code: "not_ready", message: "still waiting for a build" } }, 409);
    panel();
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    expect((await screen.findByTestId("or-your-grade-refused")).textContent).toContain("still waiting for a build");
    expect(screen.queryByTestId("or-your-grade-saved")).toBeNull();
    world.submit = () => { throw new Error("connection lost"); };
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    expect((await screen.findByTestId("or-your-grade-failed")).textContent).toContain("connection lost");
    expect(screen.queryByTestId("or-your-grade-saved")).toBeNull();
  });
  it("retrying after a lost reply reuses its submission id, and a changed answer takes a new one", async () => {
    world.submit = () => { throw new Error("connection lost"); };
    panel();
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-failed");
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await waitFor(() => expect(world.sent).toHaveLength(2));
    const [first, second] = world.sent as { submission_id: string }[];
    if (!first || !second) throw new Error("submission fixture requires both requests");
    expect(second.submission_id).toBe(first.submission_id);
    await choose(1);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await waitFor(() => expect(world.sent).toHaveLength(3));
    expect((world.sent[2] as { submission_id: string }).submission_id).not.toBe(first.submission_id);
  });
  it("a correction links the operator's current answer and keeps the earlier one listed", async () => {
    world.own = [reviewerAnswer("first", "does_not_support"), reviewerAnswer("second", "unclear", "oakridge-operator", { supersedes_observation_id: id<ObservationGradeObservationId>("first") })];
    panel();
    expect((await screen.findByTestId("or-your-grade-current")).textContent).toContain("unclear");
    expect(screen.getByTestId("or-your-grade-history").textContent).toContain("does not support");
    expect(screen.getByTestId("or-your-grade-submit").textContent).toBe("Correct your answer");
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(world.sent).toMatchObject([{ answer: "supports", corrects_observation_id: id("second") }]);
  });
  it("after another tab corrects first, a stale refusal reloads the operator's answers and the retry corrects the new one", async () => {
    world.own = [reviewerAnswer("first", "does_not_support")];
    world.submit = () => { world.own = [...world.own, reviewerAnswer("other-tab", "unclear", "oakridge-operator", { supersedes_observation_id: id<ObservationGradeObservationId>("first") })];
      return json({ error: { code: "stale_correction", message: "that answer has already been corrected" } }, 409); };
    panel();
    expect((await screen.findByTestId("or-your-grade-current")).textContent).toContain("does not support");
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-refused");
    expect(screen.getByTestId("or-your-grade-current").textContent).toContain("unclear");
    world.submit = () => json(acknowledged("supports"), 201);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(world.sent).toMatchObject([{ corrects_observation_id: id("first") }, { corrects_observation_id: id("other-tab") }]);
  });
  it("nothing can be edited while a submission is out", async () => {
    let answer: (response: Response) => void = () => {};
    world.submit = () => new Promise<Response>((resolve) => { answer = resolve; });
    panel();
    await choose(0);
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-pending");
    expect(screen.getAllByTestId("or-your-grade-choice").every((input) => (input as HTMLInputElement).disabled)).toBe(true);
    expect((screen.getByTestId("or-your-grade-rationale") as HTMLTextAreaElement).disabled).toBe(true);
    answer(json(acknowledged("supports"), 201));
    await screen.findByTestId("or-your-grade-saved");
    expect((screen.getByTestId("or-your-grade-rationale") as HTMLTextAreaElement).disabled).toBe(false);
  });
  it("an explanation alone can be corrected, starting from the stored one", async () => {
    world.own = [reviewerAnswer("first", "unclear", "oakridge-operator", { rationale: "line 4" })];
    panel();
    await screen.findByTestId("or-your-grade-current");
    const rationale = screen.getByTestId("or-your-grade-rationale") as HTMLTextAreaElement;
    expect(rationale.value).toBe("line 4");
    expect((screen.getByTestId("or-your-grade-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(rationale, { target: { value: "line 5" } });
    fireEvent.click(screen.getByTestId("or-your-grade-submit"));
    await screen.findByTestId("or-your-grade-saved");
    expect(world.sent).toMatchObject([{ answer: "unclear", rationale: "line 5", corrects_observation_id: id("first") }]);
  });
});


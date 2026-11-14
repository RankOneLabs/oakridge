import { expect, test } from "bun:test";
import { assembleInstallStatus, selectAccessMode, selectInstallationFailed, type InstallCheck } from "../src/projections/install-status-view";

for (const bind_host of ["127.0.0.1", "::1", "localhost", "[::1]"]) {
  for (const has_control_token of [false, true]) {
    test(`loopback ${bind_host} is local with token presence ${has_control_token}`, () => {
      expect(selectAccessMode({ bind_host, has_control_token, allow_insecure_non_loopback: false })).toEqual({ kind: "local", bind_host });
    });
  }
}
test("network with token is authenticated", () => {
  expect(selectAccessMode({ bind_host: "0.0.0.0", has_control_token: true, allow_insecure_non_loopback: false }).kind).toBe("authenticated_network");
});
test("explicit override allows insecure network", () => {
  expect(selectAccessMode({ bind_host: "0.0.0.0", has_control_token: false, allow_insecure_non_loopback: true }).kind).toBe("insecure_network");
});
test("refused network has a required failure with both remedies", () => {
  const result = selectAccessMode({ bind_host: "0.0.0.0", has_control_token: false, allow_insecure_non_loopback: false });
  expect(result).toMatchObject({ kind: "failed", required: true });
  if (result.kind !== "failed") throw new Error("expected refusal");
  expect(result.fix).toContain("OAKRIDGE_CONTROL_TOKEN");
  expect(result.fix).toContain("ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1");
});
const optional: InstallCheck = { kind: "unavailable_optional", id: "integration", label: "PR integration", required: false, detail: "Not selected", fix: "Select an integration" };
const unauthenticated: InstallCheck = { kind: "failed", id: "agent", label: "Agent", required: false, detail: "Not authenticated", fix: "Authenticate the CLI" };
test("optional absence and optional failure do not fail installation", () => {
  expect(selectInstallationFailed([optional, unauthenticated])).toBe(false);
});
test("required failure fails installation", () => {
  expect(selectInstallationFailed([{ ...unauthenticated, required: true }])).toBe(true);
});
test("assembled model carries presence only, never the token", () => {
  const token = "secret-status-test-token";
  const access_mode = selectAccessMode({ bind_host: "0.0.0.0", has_control_token: Boolean(token), allow_insecure_non_loopback: false });
  if (access_mode.kind === "failed") throw new Error("unexpected refusal");
  const status = assembleInstallStatus({ access_mode, checks: [], agent_profiles: [], pr_integration: { selected: "none", health: optional }, observation: { availability: optional }, launch_blocks: [] });
  expect(status.installation_failed).toBe(false);
  expect(JSON.stringify(status)).not.toContain(token);
});

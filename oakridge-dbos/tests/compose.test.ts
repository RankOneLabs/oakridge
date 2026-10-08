import { expect, test } from "bun:test";

import { isLoopbackKbblUrl } from "../src/runtime/compose";

test("recognizes loopback hostnames and the full 127.0.0.0/8 range", () => {
  expect(isLoopbackKbblUrl("http://127.0.0.1:8788")).toBe(true);
  expect(isLoopbackKbblUrl("http://127.1.2.3")).toBe(true);
  expect(isLoopbackKbblUrl("http://localhost:8788")).toBe(true);
  expect(isLoopbackKbblUrl("http://[::1]:8788")).toBe(true);
});

test("rejects a non-loopback host", () => {
  expect(isLoopbackKbblUrl("https://kbbl.example.com")).toBe(false);
  expect(isLoopbackKbblUrl("http://192.168.1.1")).toBe(false);
});

/**
 * A hostname with four dot-separated parts whose first is "127" is not
 * necessarily loopback — DNS lets "127.attacker.co.uk" resolve wherever its
 * owner wants. Checking only `parts[0] === "127"` would let it bypass the
 * fail-fast guard that requires a credential off loopback.
 */
test("a lookalike hostname starting with 127 is not treated as loopback", () => {
  expect(isLoopbackKbblUrl("http://127.attacker.co.uk")).toBe(false);
});

test("an out-of-range or non-numeric octet is not treated as loopback", () => {
  expect(isLoopbackKbblUrl("http://127.256.0.1")).toBe(false);
  expect(isLoopbackKbblUrl("http://127.0.0.1x")).toBe(false);
});

test("an unparseable URL is not treated as loopback", () => {
  expect(isLoopbackKbblUrl("not a url")).toBe(false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupportedNode } from "../node-gate.mjs";

test("accepts the CI Node major and newer releases", () => {
  assert.equal(isSupportedNode("22.0.0"), true);
  assert.equal(isSupportedNode("22"), true);
  assert.equal(isSupportedNode("24.22.3"), true);
});

test("rejects older majors and unparseable versions", () => {
  assert.equal(isSupportedNode("20.11.0"), false);
  assert.equal(isSupportedNode("18.20.0"), false);
  assert.equal(isSupportedNode("not-a-version"), false);
  assert.equal(isSupportedNode(""), false);
});
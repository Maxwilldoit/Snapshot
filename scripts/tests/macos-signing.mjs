import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { needsLocalSigning, selectSigningIdentity } from "../tauri.mjs";

const development = `  1) ${"A".repeat(40)} "Apple Development: Example (TEAM)"`;
const other = `  2) ${"B".repeat(40)} "Other certificate"`;

test("local macOS builds and rebundles require stable signing", () => {
  for (const command of ["build", "bundle"]) {
    assert.equal(needsLocalSigning("darwin", [command], {}), true);
    assert.equal(needsLocalSigning("darwin", [command, "--target", "universal-apple-darwin"], {}), true);
  }
});

test("development, other platforms, cross compilation and CI remain unchanged", () => {
  assert.equal(needsLocalSigning("darwin", ["dev"], {}), false);
  assert.equal(needsLocalSigning("win32", ["build"], {}), false);
  assert.equal(needsLocalSigning("linux", ["build"], {}), false);
  assert.equal(needsLocalSigning("darwin", ["build"], { CI: "true" }), false);
  for (const args of [["--target", "x86_64-pc-windows-msvc"], ["-t", "aarch64-unknown-linux-gnu"], ["--target=x86_64-pc-windows-msvc"]]) {
    assert.equal(needsLocalSigning("darwin", ["build", ...args], {}), false);
  }
});

test("a unique Apple Development identity is selected by fingerprint, not an arbitrary certificate", () => {
  assert.equal(selectSigningIdentity(undefined, `${development}\n${other}\n2 valid identities found`), "A".repeat(40));
});

test("explicit distribution, custom or ad-hoc identities are preserved", () => {
  for (const identity of ["Developer ID Application: Example", "Local Development", "-"]) {
    assert.equal(selectSigningIdentity(` ${identity} `, ""), identity);
  }
});

test("missing or ambiguous development certificates never silently fall back to ad-hoc", () => {
  assert.throws(() => selectSigningIdentity(undefined, other), /APPLE_SIGNING_IDENTITY/);
  assert.throws(() => selectSigningIdentity(" ", `${development}\n${development}`), /APPLE_SIGNING_IDENTITY/);
});

test("certificate-signed bundles retain microphone recording support without disabling hardened runtime", () => {
  const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"));
  const entitlements = readFileSync(new URL(`../../src-tauri/${config.bundle.macOS.entitlements}`, import.meta.url), "utf8");
  assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
  assert.notEqual(config.bundle.macOS.hardenedRuntime, false);
});

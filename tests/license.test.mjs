import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// fileURLToPath, not URL.pathname: the latter is percent-encoded, so a clone
// under `C:\Users\First Last\` resolved to a directory that does not exist and
// esbuild failed with "could not resolve entry point" instead of anything useful.
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// The round-trip below signs a real key, which needs the author's private key.
// It is gitignored, so on a fresh clone or in CI this whole file used to throw
// before its first assertion — and because the runner chains with &&, it took
// the help and manifest-contract suites down with it, including the manifest
// checks that exist specifically to stop a bad Obsidian submission.
const privateKeyPath = path.join(root, "scripts/.license-private.key");
if (!fs.existsSync(privateKeyPath)) {
  console.log("license tests skipped (no scripts/.license-private.key on this machine)");
  process.exit(0);
}

const outfile = path.join(os.tmpdir(), `task-calendar-license-${Date.now()}.mjs`);

await build({
  entryPoints: [path.join(root, "src/license/LicenseManager.ts")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2018",
  outfile,
});

const output = execSync("node scripts/generate-license.mjs buyer@example.com", { cwd: root, encoding: "utf8" });
const keyLine = output.split("\n").find((line) => line.startsWith("Key:"));
assert.ok(keyLine, "license generator should print a key");
const licenseKey = keyLine.replace("Key:", "").trim();
assert.equal(licenseKey.split(".").length, 2);

globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");
const { LicenseManager } = await import(`file://${outfile.replace(/\\/g, "/")}`);
const valid = LicenseManager.verify(licenseKey);
assert.equal(valid.valid, true);
assert.equal(valid.email, "buyer@example.com");

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const [payloadB64, signatureB64] = licenseKey.split(".");
const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

// A tampered payload must not verify against the original signature.
assert.equal(LicenseManager.verify(`${encode({ ...payload, email: "attacker@example.com" })}.${signatureB64}`).valid, false);

// The product gate had no test at all: deleting the `payload.product` check left
// the whole suite green. That check is what stops a key minted for one plugin in
// this portfolio from unlocking another — which has happened, when two products
// briefly shipped with the same verification key.
const otherProduct = LicenseManager.verify(`${encode({ ...payload, product: "note-doctor" })}.${signatureB64}`);
assert.equal(otherProduct.valid, false, "a key for another product must be rejected");

// Malformed input must be rejected, never thrown on.
for (const bad of ["", "   ", "not-a-key", "a.b.c", "!!!.???", `${payloadB64}.`, `.${signatureB64}`]) {
  const result = LicenseManager.verify(bad);
  assert.equal(result.valid, false, `"${bad}" must not verify`);
  assert.ok(result.error, `"${bad}" must explain itself`);
}

fs.unlinkSync(outfile);
console.log("license tests passed");

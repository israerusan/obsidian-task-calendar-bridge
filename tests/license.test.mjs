import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { build } from "esbuild";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1"));
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
const [payloadB64, signatureB64] = licenseKey.split(".");
const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
payload.email = "attacker@example.com";
const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
assert.equal(LicenseManager.verify(`${tamperedPayloadB64}.${signatureB64}`).valid, false);

fs.unlinkSync(outfile);
console.log("license tests passed");
